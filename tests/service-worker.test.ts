import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// public/sw.js ships as-is to the browser, so nothing type checks or exercises
// it. Load it into a stand-in ServiceWorkerGlobalScope and drive its events.

type Listener = (event: WorkerEvent) => void
type WorkerEvent = { request?: Request; data?: { type: string }; waitUntil: (p: Promise<unknown>) => void; respondWith: (r: unknown) => void }

class FakeCache {
    entries = new Map<string, Response>()
    async put(request: Request | string, response: Response) {
        this.entries.set(typeof request === 'string' ? request : request.url, response.clone())
    }
    async match(request: Request | string) {
        const key = typeof request === 'string' ? request : request.url
        const body = this.entries.get(key) ?? this.entries.get(new URL(key, 'https://app.test').pathname)
        return body === undefined ? undefined : body.clone()
    }
    async delete(request: Request | string) {
        const key = typeof request === 'string' ? request : request.url
        return this.entries.delete(key) || this.entries.delete(new URL(key, 'https://app.test').pathname)
    }
    async keys() {
        return [...this.entries.keys()].map((url) => new Request(new URL(url, 'https://app.test')))
    }
}

class FakeCaches {
    stores = new Map<string, FakeCache>()
    async open(name: string) {
        if (!this.stores.has(name)) this.stores.set(name, new FakeCache())
        return this.stores.get(name)!
    }
    async keys() { return [...this.stores.keys()] }
    async delete(name: string) { return this.stores.delete(name) }
    async match(request: Request | string) {
        for (const store of this.stores.values()) {
            const hit = await store.match(request)
            if (hit) return hit
        }
        return undefined
    }
}

type Harness = {
    listeners: Map<string, Listener>
    caches: FakeCaches
    fetches: string[]
    skipWaitingCalls: number
    claimCalls: number
    install: () => Promise<void>
    activate: () => Promise<void>
    respond: (request: Request) => Promise<Response>
    intercepts: (request: Request) => boolean
}

async function loadWorker(
    { fetchImpl, version = 'pancake-test-1', precache = ['/', '/_expo/static/js/web/app.js'], hashes = {}, allowed, storage, clients = [], claimFailure = false }:
    { fetchImpl?: (input: Request | string) => Promise<Response>; version?: string; precache?: string[]; hashes?: Record<string, string>; allowed?: string[]; storage?: FakeCaches; clients?: { url: string; postMessage: (message: unknown, ports: MessagePort[]) => void }[]; claimFailure?: boolean } = {},
): Promise<Harness> {
    let source = await readFile(path.join(process.cwd(), 'public/sw.js'), 'utf8')
    source = source
        .replace(/const VERSION = '[^']*'/, `const VERSION = '${version}'`)
        .replace(/const PRECACHE_URLS = \[[^\]]*\]/, `const PRECACHE_URLS = ${JSON.stringify(precache)}`)
        .replace(/const PUBLIC_ASSET_URLS = \[[^\n]*\]/, `const PUBLIC_ASSET_URLS = ${JSON.stringify(allowed ?? [...precache.filter(p => p !== '/'), '/_expo/static/js/web/chunk.js', '/_expo/static/js/web/old-chunk.js', '/manifest.webmanifest'])}`)
        .replace(/const SHELL_ROUTES = \[[^\n]*\]/, "const SHELL_ROUTES = ['/', '/players', '/player/[id]']")

    source = source.replace(/const PUBLIC_ASSET_HASHES = \{[^\n]*\}/, `const PUBLIC_ASSET_HASHES = ${JSON.stringify({ ...Object.fromEntries(precache.map(url => [url, createHash('sha256').update(`body:https://app.test${url}`).digest('hex')])), ...hashes })}`)

    const listeners = new Map<string, Listener>()
    // Successive releases share one Cache Storage, as they do in a browser.
    const cacheStorage = storage ?? new FakeCaches()
    const fetches: string[] = []
    const harness = { listeners, caches: cacheStorage, fetches, skipWaitingCalls: 0, claimCalls: 0 } as Harness

    const fakeFetch = async (input: Request | string) => {
        const url = typeof input === 'string' ? input : input.url
        fetches.push(new URL(url, 'https://app.test').pathname)
        if (fetchImpl) return fetchImpl(input)
        return new Response(`body:${url}`, { status: 200, headers: { 'content-type': new URL(url).pathname === '/' ? 'text/html' : 'application/javascript' } })
    }

    const self = {
        addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
        skipWaiting: async () => { harness.skipWaitingCalls += 1 },
        clients: { matchAll: async () => clients, claim: async () => { harness.claimCalls += 1; if (claimFailure) throw new Error('Claim failed') } },
        location: { origin: 'https://app.test' },
    }

    // In a worker, relative URLs resolve against the scope; Node's Request
    // rejects them, so resolve before constructing.
    class ScopedRequest extends Request {
        constructor(input: RequestInfo, init?: RequestInit) {
            super(typeof input === 'string' ? new URL(input, 'https://app.test').toString() : input, init)
        }
    }

    new Function('self', 'caches', 'fetch', 'Request', 'Response', 'URL', source)(
        self, cacheStorage, fakeFetch, ScopedRequest, Response, URL,
    )

    const drive = (type: string) => async () => {
        const pending: Promise<unknown>[] = []
        listeners.get(type)?.({ waitUntil: (p) => pending.push(p), respondWith: () => {} })
        await Promise.all(pending)
    }
    harness.intercepts = (request) => {
        let intercepted = false
        listeners.get('fetch')?.({ request, waitUntil: () => {}, respondWith: () => { intercepted = true } })
        return intercepted
    }
    harness.install = drive('install')
    harness.activate = drive('activate')
    harness.respond = (request) => {
        const pending: Promise<unknown>[] = []
        let responded: unknown = new Error('fetch listener did not call respondWith')
        listeners.get('fetch')?.({
            request,
            waitUntil: (p) => pending.push(p),
            respondWith: (r) => { responded = r },
        })
        return Promise.resolve(responded).then(async (value) => {
            await Promise.allSettled(pending)
            if (value instanceof Error) throw value
            if (!(value instanceof Response)) throw new TypeError(`respondWith resolved to ${String(value)}`)
            return value
        })
    }
    return harness
}

describe('service worker', () => {
    beforeEach(() => vi.restoreAllMocks())

    it('precaches every declared boot asset on install', async () => {
        const worker = await loadWorker()
        await worker.install()

        expect(worker.fetches).toEqual(expect.arrayContaining(['/', '/_expo/static/js/web/app.js']))
        const assets = await worker.caches.open('pancake-test-1-public-v1-assets')
        expect(assets.entries.size).toBe(1)
        const shell = await worker.caches.open('pancake-test-1-public-v1-shell')
        expect(shell.entries.size).toBe(1)
        expect(worker.skipWaitingCalls).toBe(1)
    })

    it('installs when CacheStorage accepts one file write at a time', async () => {
        const worker = await loadWorker({ precache: ['/', '/_expo/static/js/web/app.js', '/_expo/static/js/web/chunk.js'] })
        let writing = false
        for (const name of ['pancake-test-1-public-v1-shell', 'pancake-test-1-public-v1-assets']) {
            const cache = await worker.caches.open(name)
            const put = cache.put.bind(cache)
            vi.spyOn(cache, 'put').mockImplementation(async (request, response) => {
                if (writing) throw new TypeError('Failed writing data to the file system')
                writing = true
                try {
                    await new Promise(resolve => setTimeout(resolve, 0))
                    await put(request, response)
                } finally { writing = false }
            })
        }
        await worker.install()
        expect(worker.skipWaitingCalls).toBe(1)
        expect((await worker.caches.open('pancake-test-1-public-v1-assets')).entries.size).toBe(2)
    })

    it('rejects a required manifest entry the host no longer serves', async () => {
        const worker = await loadWorker({
            precache: ['/', '/_expo/static/js/web/gone.js'],
            fetchImpl: async (input) => {
                const url = typeof input === 'string' ? input : input.url
                return url.includes('gone.js')
                    ? new Response('missing', { status: 404 })
                    : new Response('body', { status: 200 })
            },
        })

        await expect(worker.install()).rejects.toThrow()
        const assets = await worker.caches.open('pancake-test-1-public-v1-assets')
        expect(assets.entries.size).toBe(0)
        expect(worker.skipWaitingCalls).toBe(0)
    })

    // Activation deletes the previous release's caches. Installing on a dead
    // link and activating anyway would leave a launch with neither release.
    it('fails the install when the network is unavailable', async () => {
        const worker = await loadWorker({
            fetchImpl: async () => { throw new TypeError('Failed to fetch') },
        })

        await expect(worker.install()).rejects.toThrow(/Failed to fetch/)
        expect(worker.skipWaitingCalls).toBe(0)
    })

    it('drops only other releases caches on activate', async () => {
        const worker = await loadWorker()
        await worker.caches.open('pancake-old-1-assets')
        await worker.caches.open('pancake-old-1-shell')
        await worker.caches.open('unrelated-cache')
        await worker.install()

        await worker.activate()

        expect((await worker.caches.keys()).sort()).toEqual([
            'pancake-test-1-public-v1-assets',
            'pancake-test-1-public-v1-shell',
            'unrelated-cache',
        ])
        expect(worker.claimCalls).toBe(1)
    })

    const html = () => new Response('<!doctype html><title>Not found</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
    })
    const script = (body = 'console.log(1)') => new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/javascript' },
    })
    const scoped = (pathname: string) => new Request(`https://app.test${pathname}`)
    // Node's Request refuses mode 'navigate'; the worker only reads url/method/mode.
    const navigation = (pathname: string) =>
        ({ url: `https://app.test${pathname}`, method: 'GET', mode: 'navigate', headers: new Headers() }) as unknown as Request

    // The host rewrites unknown paths to +not-found.html with HTTP 200. After a
    // deploy, a still-running old bundle asking for its previous hashed chunk
    // gets that document back; it must never be stored under the asset URL.
    it('never caches an HTML rewrite under an immutable asset URL', async () => {
        const worker = await loadWorker({ fetchImpl: async () => html() })
        const response = await worker.respond(scoped('/_expo/static/js/web/old-chunk.js'))

        expect(response.status).toBe(502)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('content-type')).not.toContain('text/html')
        const assets = await worker.caches.open('pancake-test-1-public-v1-assets')
        expect(assets.entries.size).toBe(0)
    })

    it.each(['/unlisted.js', '/_expo/static/js/web/unlisted.js?old=1'])(
        'rejects HTML for an unlisted script %s', async pathname => {
            const worker = await loadWorker({ fetchImpl: async () => html() })
            const request = scoped(pathname)
            Object.defineProperty(request, 'destination', { value: 'script' })
            const response = await worker.respond(request)
            expect(response.status).toBe(502)
            expect(response.headers.get('cache-control')).toBe('no-store')
            expect(await response.text()).not.toContain('<!doctype')
        },
    )

    it('caches a real script under an immutable asset URL and serves it cache-first', async () => {
        const worker = await loadWorker({ fetchImpl: async () => script() })
        await worker.respond(scoped('/_expo/static/js/web/chunk.js'))
        await worker.respond(scoped('/_expo/static/js/web/chunk.js'))

        const assets = await worker.caches.open('pancake-test-1-public-v1-assets')
        expect(assets.entries.size).toBe(1)
        expect(worker.fetches.filter((p) => p.endsWith('chunk.js'))).toHaveLength(1)
    })

    it('rejects a required precache entry the host rewrites to a document', async () => {
        const worker = await loadWorker({
            precache: ['/', '/_expo/static/js/web/renamed.js'],
            fetchImpl: async (input) => {
                const url = typeof input === 'string' ? input : input.url
                // The shell is a document; the renamed chunk comes back as the 404 rewrite.
                return url.endsWith('renamed.js') ? html() : new Response('<!doctype html><title>Pancake</title>', { status: 200, headers: { 'content-type': 'text/html' } })
            },
        })
        await expect(worker.install()).rejects.toThrow()
        expect(worker.skipWaitingCalls).toBe(0)

        const shell = await worker.caches.open('pancake-test-1-public-v1-shell')
        expect(shell.entries.size).toBe(0)
        const assets = await worker.caches.open('pancake-test-1-public-v1-assets')
        expect(assets.entries.size).toBe(0)
    })

    // A cold cache plus a dead network used to resolve respondWith(undefined),
    // which the browser treats as a hard failure the outer fallback never sees.
    it('rejects rather than resolving undefined when offline with a cold cache', async () => {
        const worker = await loadWorker({
            fetchImpl: async () => { throw new TypeError('Failed to fetch') },
        })

        await expect(worker.respond(scoped('/manifest.webmanifest'))).rejects.toThrow(/Failed to fetch/)
        await expect(worker.respond(scoped('/_expo/static/js/web/chunk.js'))).rejects.toThrow(/Failed to fetch/)
        await expect(worker.respond(navigation('/players'))).rejects.toThrow(/Failed to fetch/)
    })

    it('serves the cached entry when offline after a warm load', async () => {
        let online = true
        const worker = await loadWorker({
            fetchImpl: async () => {
                if (!online) throw new TypeError('Failed to fetch')
                return new Response('{"name":"Pancake"}', { status: 200, headers: { 'content-type': 'application/manifest+json' } })
            },
        })
        await worker.respond(scoped('/manifest.webmanifest'))
        online = false

        const response = await worker.respond(scoped('/manifest.webmanifest'))
        expect(await response.text()).toContain('Pancake')
    })

    it.each(['asset', 'shell'])('finishes the %s cache fill before resolving a miss', async (kind) => {
        const response = new Response('updated', { headers: { 'content-type': kind === 'shell' ? 'text/html' : 'application/manifest+json' } })
        const worker = await loadWorker({ fetchImpl: async () => response, hashes: { '/': createHash('sha256').update('updated').digest('hex') } })
        const cache = await worker.caches.open(`pancake-test-1-public-v1-${kind === 'shell' ? 'shell' : 'assets'}`)
        const request = kind === 'shell' ? navigation('/') : scoped('/manifest.webmanifest')
        let releaseWrite!: () => void
        let writeStarted!: () => void
        const blocked = new Promise<void>((resolve) => { releaseWrite = resolve })
        const started = new Promise<void>((resolve) => { writeStarted = resolve })
        const put = cache.put.bind(cache)
        vi.spyOn(cache, 'put').mockImplementation(async (...args) => {
            writeStarted()
            await blocked
            await put(...args)
        })
        let finished = false
        const result = worker.respond(request).then(value => { finished = true; return value })
        await started
        expect(finished).toBe(false)
        releaseWrite()
        expect(await (await result).text()).toBe('updated')
        expect(await (await cache.match(kind === 'shell' ? '/' : request))?.text()).toBe('updated')
    })

    // An install that cannot fetch the shell must not activate: activation
    // deletes the previous release's shell, and a launch with no shell at all
    // has nothing to paint offline.
    it('fails the install when the shell itself is not served', async () => {
        const worker = await loadWorker({
            precache: ['/', '/_expo/static/js/web/app.js'],
            fetchImpl: async (input) => {
                const url = typeof input === 'string' ? input : input.url
                return new URL(url).pathname === '/' ? new Response('gone', { status: 503 }) : script()
            },
        })
        await expect(worker.install()).rejects.toThrow(/shell/i)
        expect(worker.skipWaitingCalls).toBe(0)
    })

    it.each([
        ['/api/profile', {}], ['/auth/token', {}], ['/private.json', {}],
        ['/_expo/static/js/web/chunk.js', { headers: { Authorization: 'Bearer fixture' } }],
        ['/_expo/static/js/web/chunk.js', { headers: { apikey: 'fixture' } }],
        ['/_expo/static/js/web/chunk.js', { headers: { 'x-api-key': 'fixture' } }],
        ['/_expo/static/js/web/chunk.js', { headers: { 'Cache-Control': 'no-store' } }],
        ['/_expo/static/js/web/chunk.js', { cache: 'no-store' }],
        ['/_expo/static/js/web/chunk.js', { method: 'POST' }],
        ['/_expo/static/js/web/chunk.js', { headers: { Range: 'bytes=0-10' } }],
    ] as [string, RequestInit][])('bypasses non-public request %s %j', async (url, init) => {
        const worker = await loadWorker()
        expect(worker.intercepts(new Request(`https://app.test${url}`, init))).toBe(false)
        expect(worker.fetches).toHaveLength(0)
    })

    it('bypasses cross-origin assets and unknown navigations', async () => {
        const worker = await loadWorker()
        expect(worker.intercepts(new Request('https://other.test/_expo/static/js/web/chunk.js'))).toBe(false)
        expect(worker.intercepts(navigation('/api/private'))).toBe(false)
    })

    it.each([
        { 'cache-control': 'private, max-age=60' }, { 'cache-control': 'public, no-store' },
        { 'cache-control': 'no-cache' }, { vary: 'Cookie' }, { vary: 'Authorization' },
        { vary: '*' }, { vary: 'Accept-Encoding, X-Account' },
    ] as Record<string, string>[])('never persists or serves a disallowed response: %j', async (headers) => {
        let owner = 'A'
        const worker = await loadWorker({ fetchImpl: async () => new Response(owner, { headers }) })
        const request = scoped('/_expo/static/js/web/chunk.js')
        const cache = await worker.caches.open('pancake-test-1-public-v1-assets')
        await cache.put(request, new Response('poison', { headers }))
        expect(await (await worker.respond(request)).text()).toBe('A')
        owner = 'B'
        expect(await (await worker.respond(request)).text()).toBe('B')
        expect(cache.entries.size).toBe(0)
    })

    it('uses anonymous fills and accepts only harmless response variation', async () => {
        const observed: Request[] = []
        const worker = await loadWorker({ fetchImpl: async input => {
            observed.push(input as Request)
            return new Response('public', { headers: { vary: 'Accept-Encoding' } })
        } })
        await worker.respond(new Request('https://app.test/_expo/static/js/web/chunk.js', {
            headers: { 'X-Account': 'fixture' }, credentials: 'include',
        }))
        expect(observed[0].credentials).toBe('omit')
        expect(observed[0].redirect).toBe('error')
        expect(observed[0].cache).toBe('no-store')
        expect([...observed[0].headers]).toEqual([])
    })

    it('keeps declared public shell routes offline with route parameters and trailing slashes', async () => {
        const worker = await loadWorker({ fetchImpl: async () => { throw new TypeError('offline') }, hashes: { '/': createHash('sha256').update(await html().text()).digest('hex') } })
        await (await worker.caches.open('pancake-test-1-public-v1-shell')).put('/', html())
        for (const route of ['/players/?tab=saved', '/player/fixture-player?view=stats']) {
            expect(await (await worker.respond(navigation(route))).text()).toContain('Not found')
        }
    })

    it('renders an unknown page from the verified root shell while offline', async () => {
        const body = await html().text()
        const worker = await loadWorker({ fetchImpl: async () => { throw new TypeError('offline') }, hashes: { '/': createHash('sha256').update(body).digest('hex') } })
        const cache = await worker.caches.open('pancake-test-1-public-v1-shell')
        await cache.put('/', html())
        expect(await (await worker.respond(navigation('/surface-contract-not-found'))).text()).toBe(body)
        expect([...cache.entries.keys()]).toEqual(['/'])
        for (const route of ['/api/private', '/rest/v1/players', '/auth/v1/user', '/functions/v1/api', '/storage/v1/private', '/realtime/v1/websocket', '/graphql/v1']) {
            expect(worker.intercepts(navigation(route))).toBe(false)
        }
    })

    it('cannot read a poisoned matching URL from the legacy cache before or after activation', async () => {
        const worker = await loadWorker({ fetchImpl: async input => new URL((input as Request).url).pathname === '/' ? new Response('public', { headers: { 'content-type': 'text/html' } }) : script('public'), hashes: { '/': createHash('sha256').update('public').digest('hex') } })
        const legacy = await worker.caches.open('pancake-test-1-assets')
        await legacy.put('/_expo/static/js/web/chunk.js', new Response('account A'))
        const oldShell = await worker.caches.open('pancake-test-1-shell')
        await oldShell.put('/', new Response('account A'))
        expect(await (await worker.respond(scoped('/_expo/static/js/web/chunk.js'))).text()).toBe('public')
        expect(await (await worker.respond(navigation('/'))).text()).toBe('public')
        await worker.activate()
        expect(await worker.caches.keys()).not.toContain('pancake-test-1-assets')
        expect(await worker.caches.keys()).not.toContain('pancake-test-1-shell')
    })

    it('never stores a redirected or opaque response', async () => {
        for (const property of [{ redirected: true }, { type: 'opaque' }]) {
            const response = script('private redirect')
            for (const [key, value] of Object.entries(property)) Object.defineProperty(response, key, { value })
            const worker = await loadWorker({ fetchImpl: async () => response })
            await worker.respond(scoped('/_expo/static/js/web/chunk.js'))
            expect((await worker.caches.open('pancake-test-1-public-v1-assets')).entries.size).toBe(0)
        }
    })

    it.each(['public', 'private-header', 'poison-public-header'])(
        'validates offline HTTP-cache bytes against the build: %s', async (kind) => {
            const body = 'public build chunk'
            const worker = await loadWorker({
                hashes: { '/_expo/static/js/web/chunk.js': createHash('sha256').update(body).digest('hex') },
                fetchImpl: async input => {
                    const request = input as Request
                    if (!['force-cache', 'only-if-cached'].includes(request.cache)) throw new TypeError('offline')
                    expect(request.credentials).toBe('omit')
                    return new Response(kind === 'poison-public-header' ? 'account A' : body, {
                        headers: { 'cache-control': kind === 'private-header' ? 'private' : 'public' },
                    })
                },
            })
            const result = worker.respond(scoped('/_expo/static/js/web/chunk.js'))
            if (kind === 'public') expect(await (await result).text()).toBe(body)
            else await expect(result).rejects.toThrow('offline')
        },
    )

    it('falls back to network when cache storage is denied', async () => {
        const worker = await loadWorker({ fetchImpl: async () => script('public') })
        vi.spyOn(worker.caches, 'open').mockRejectedValue(new Error('denied'))
        expect(await (await worker.respond(scoped('/_expo/static/js/web/chunk.js'))).text()).toBe('public')
    })

    it.each<ResponseInit>([
        { status: 503 }, { headers: { 'cache-control': 'private' } },
        { headers: { 'cache-control': 'no-store' } }, { headers: { vary: 'Cookie' } },
        { headers: { vary: '*' } }, { headers: { 'content-type': 'text/html' } },
    ])('rejects an unsafe required asset without writing a shell: %j', async init => {
        const worker = await loadWorker({ fetchImpl: async input => {
            const url = (input as Request).url
            return new URL(url).pathname === '/'
                ? new Response(`body:${url}`, { headers: { 'content-type': 'text/html' } })
                : new Response(`body:${url}`, init)
        } })
        await expect(worker.install()).rejects.toThrow()
        expect(worker.skipWaitingCalls).toBe(0)
        expect((await worker.caches.open('pancake-test-1-public-v1-shell')).entries.size).toBe(0)
    })

    it('rejects correct headers with bytes from the wrong release', async () => {
        const worker = await loadWorker({ fetchImpl: async input => new Response(
            new URL((input as Request).url).pathname === '/' ? `body:${(input as Request).url}` : 'wrong release',
            { headers: { 'content-type': new URL((input as Request).url).pathname === '/' ? 'text/html' : 'application/javascript' } },
        ) })
        await expect(worker.install()).rejects.toThrow(/asset precache rejected/)
        expect(worker.skipWaitingCalls).toBe(0)
    })

    it('rejects an undeclared required path before it can activate', async () => {
        const worker = await loadWorker({ precache: ['/', '/api/private'], allowed: [] })
        await expect(worker.install()).rejects.toThrow(/invalid required boot manifest/)
        expect(worker.fetches).toHaveLength(0)
    })

    it('bounds a stalled required download and aborts its request', async () => {
        vi.useFakeTimers()
        try {
            const requests: Request[] = []
            const worker = await loadWorker({ fetchImpl: async input => {
                requests.push(input as Request)
                return new Promise<Response>(() => {})
            } })
            const result = expect(worker.install()).rejects.toThrow(/timed out/)
            await vi.advanceTimersByTimeAsync(30000)
            await result
            expect(requests.every(request => request.signal.aborted)).toBe(true)
            expect(worker.skipWaitingCalls).toBe(0)
        } finally { vi.useRealTimers() }
    })

    it('refills an orphan partial cache instead of trusting its shell or asset bytes', async () => {
        const worker = await loadWorker()
        const shell = await worker.caches.open('pancake-test-1-public-v1-shell')
        const assets = await worker.caches.open('pancake-test-1-public-v1-assets')
        await shell.put('/', new Response('orphan'))
        await assets.put('/_expo/static/js/web/app.js', new Response('partial'))
        await worker.install()
        expect(await (await shell.match('/'))?.text()).toBe('body:https://app.test/')
        expect(await (await assets.match('/_expo/static/js/web/app.js'))?.text()).toBe('body:https://app.test/_expo/static/js/web/app.js')
        expect(worker.fetches).toHaveLength(2)
        expect(worker.skipWaitingCalls).toBe(1)
    })

    it('cannot activate after a required cache write rejects, and retries the full set', async () => {
        const worker = await loadWorker()
        const old = await worker.caches.open('pancake-old-public-v1-shell')
        await old.put('/', new Response('usable old release'))
        const assets = await worker.caches.open('pancake-test-1-public-v1-assets')
        const put = vi.spyOn(assets, 'put').mockRejectedValueOnce(new Error('quota'))
        await expect(worker.install()).rejects.toThrow('quota')
        expect(worker.skipWaitingCalls).toBe(0)
        expect(await (await old.match('/'))?.text()).toBe('usable old release')
        put.mockRestore()
        await worker.install()
        expect(worker.fetches).toHaveLength(4)
        expect(worker.skipWaitingCalls).toBe(1)
    })

    it('keeps a usable release shell when the host serves a different release', async () => {
        const worker = await loadWorker({ fetchImpl: async () => new Response('new shell missing its chunk', { headers: { 'content-type': 'text/html' } }), hashes: { '/': createHash('sha256').update('old shell').digest('hex') } })
        const shell = await worker.caches.open('pancake-test-1-public-v1-shell')
        await shell.put('/', new Response('old shell', { headers: { 'content-type': 'text/html' } }))
        expect(await (await worker.respond(navigation('/'))).text()).toBe('old shell')
        expect(await (await shell.match('/'))?.text()).toBe('old shell')
        await shell.delete('/')
        expect(await (await worker.respond(navigation('/'))).text()).toBe('new shell missing its chunk')
        expect(await shell.match('/')).toBeUndefined()
    })

    it('carries only current verified public lazy bytes before discarding a warmed release', async () => {
        const body = 'verified lazy module'
        const url = '/_expo/static/js/web/chunk.js'
        const worker = await loadWorker({ hashes: { [url]: createHash('sha256').update(body).digest('hex') } })
        const old = await worker.caches.open('pancake-old-public-v1-assets')
        await old.put(url, script(body))
        await old.put('/private.json', new Response('account A'))
        await worker.install()
        const current = await worker.caches.open('pancake-test-1-public-v1-assets')
        expect(await (await current.match(url))?.text()).toBe(body)
        expect(await current.match('/private.json')).toBeUndefined()
        await worker.activate()
        expect(await worker.caches.keys()).not.toContain('pancake-old-public-v1-assets')
        expect(await (await worker.respond(scoped(url))).text()).toBe(body)
    })

    it('does not commit an upgrade until the carried lazy asset write is durable', async () => {
        const body = 'verified lazy module'
        const url = '/_expo/static/js/web/chunk.js'
        const worker = await loadWorker({ hashes: { [url]: createHash('sha256').update(body).digest('hex') } })
        const old = await worker.caches.open('pancake-old-public-v1-assets')
        await old.put(url, script(body))
        const current = await worker.caches.open('pancake-test-1-public-v1-assets')
        const original = current.put.bind(current)
        const put = vi.spyOn(current, 'put').mockImplementation(async (key, value) => {
            if (key === url) throw new Error('quota')
            return original(key, value)
        })
        await expect(worker.install()).rejects.toThrow('quota')
        expect(worker.skipWaitingCalls).toBe(0)
        expect(await (await old.match(url))?.text()).toBe(body)
        put.mockRestore()
        await worker.install()
        expect(await (await current.match(url))?.text()).toBe(body)
        expect(worker.skipWaitingCalls).toBe(1)
    })

    it.each(['private', 'no-store', 'vary-cookie', 'html', 'wrong-bytes', 'unknown', 'legacy'])(
        'does not carry unsafe or unattributed old delivery: %s', async (kind) => {
            const url = '/_expo/static/js/web/chunk.js'
            const body = 'verified lazy module'
            const worker = await loadWorker({ hashes: { [url]: createHash('sha256').update(body).digest('hex') } })
            const old = await worker.caches.open(kind === 'legacy' ? 'pancake-old-assets' : 'pancake-old-public-v1-assets')
            const headers: Record<string, string> = { 'content-type': 'application/javascript' }
            if (kind === 'private' || kind === 'no-store') headers['cache-control'] = kind
            if (kind === 'vary-cookie') headers.vary = 'Cookie'
            if (kind === 'html') headers['content-type'] = 'text/html'
            await old.put(kind === 'unknown' ? '/private.json' : url, new Response(kind === 'wrong-bytes' ? 'account A' : body, { headers }))
            await worker.install()
            const current = await worker.caches.open('pancake-test-1-public-v1-assets')
            expect(await current.match(url)).toBeUndefined()
            expect(await current.match('/private.json')).toBeUndefined()
        },
    )

    it('removes poisoned orphan lazy entries and refills only verified old bytes', async () => {
        const url = '/_expo/static/js/web/chunk.js'
        const body = 'verified lazy module'
        const worker = await loadWorker({ hashes: { [url]: createHash('sha256').update(body).digest('hex') } })
        const current = await worker.caches.open('pancake-test-1-public-v1-assets')
        await current.put(url, script('private poison'))
        await worker.install()
        expect(await current.match(url)).toBeUndefined()
        const old = await worker.caches.open('pancake-old-public-v1-assets')
        await old.put(url, script(body))
        await worker.install()
        expect(await (await current.match(url))?.text()).toBe(body)
    })

    it('carries from at most the eight newest prior generations', async () => {
        const url = '/_expo/static/js/web/chunk.js'
        const body = 'verified lazy module'
        const hashes = { [url]: createHash('sha256').update(body).digest('hex') }
        const storage = new FakeCaches()
        // Creation order is oldest first; only the oldest generation holds the module.
        for (let i = 0; i < 10; i++) await storage.open(`pancake-old-${i}-public-v1-assets`)
        await (await storage.open('pancake-old-0-public-v1-assets')).put(url, script(body))
        const worker = await loadWorker({ hashes, storage })
        const opened: string[] = []
        const open = storage.open.bind(storage)
        vi.spyOn(storage, 'open').mockImplementation(async (name) => { opened.push(name); return open(name) })
        await worker.install()
        expect(worker.skipWaitingCalls).toBe(1)
        const prior = opened.filter(name => name.startsWith('pancake-old-'))
        expect(prior).toEqual(Array.from({ length: 8 }, (_, i) => `pancake-old-${9 - i}-public-v1-assets`))
        expect(await (await storage.open('pancake-test-1-public-v1-assets')).match(url)).toBeUndefined()
        // Nothing is removed before activation commits the new release.
        expect((await storage.keys()).filter(name => name.startsWith('pancake-old-'))).toHaveLength(10)
    })

    it('recovers a healthy update after nine distinct failed release installs', async () => {
        const storage = new FakeCaches()
        const open = storage.open.bind(storage)
        let failingVersion: string | undefined
        // Emulated storage quota: the failing release's own cache writes are refused.
        vi.spyOn(storage, 'open').mockImplementation(async (name) => {
            const cache = await open(name)
            if (failingVersion && name.startsWith(`${failingVersion}-`)) {
                cache.put = async () => { throw new Error('QuotaExceededError') }
            }
            return cache
        })
        const active = await loadWorker({ version: 'pancake-active', storage })
        await active.install()
        await active.activate()
        const activeShell = await (await storage.open('pancake-active-public-v1-shell')).match('/')
        const activeShellText = await activeShell!.text()

        for (let i = 1; i <= 9; i++) {
            failingVersion = `pancake-failed-${i}`
            const candidate = await loadWorker({ version: failingVersion, storage })
            await expect(candidate.install()).rejects.toThrow('QuotaExceededError')
            expect(candidate.skipWaitingCalls).toBe(0)
            expect(await storage.keys()).toContain(`${failingVersion}-public-v1-assets`)
            expect(await (await (await storage.open('pancake-active-public-v1-shell')).match('/'))!.text()).toBe(activeShellText)
            expect(await (await (await storage.open('pancake-active-public-v1-assets')).match('/_expo/static/js/web/app.js'))!.text())
                .toBe('body:https://app.test/_expo/static/js/web/app.js')
            // The installed release keeps serving while the candidate is stuck.
            expect(await (await active.respond(navigation('/'))).text()).toBe(activeShellText)
        }
        failingVersion = undefined
        expect((await storage.keys()).filter(name => name.endsWith('-public-v1-assets'))).toHaveLength(10)

        const healthy = await loadWorker({ version: 'pancake-healthy', storage })
        await healthy.install()
        expect(healthy.skipWaitingCalls).toBe(1)
        expect(await (await (await storage.open('pancake-healthy-public-v1-shell')).match('/'))!.text()).toBe('body:https://app.test/')
        expect(await (await (await storage.open('pancake-healthy-public-v1-assets')).match('/_expo/static/js/web/app.js'))!.text())
            .toBe('body:https://app.test/_expo/static/js/web/app.js')
        expect(await storage.keys()).toContain('pancake-active-public-v1-shell')
        expect(await storage.keys()).toContain('pancake-failed-1-public-v1-assets')
        await healthy.activate()
        expect(healthy.claimCalls).toBe(1)
        expect((await storage.keys()).sort()).toEqual(['pancake-healthy-public-v1-assets', 'pancake-healthy-public-v1-shell'])
        expect(await (await healthy.respond(navigation('/'))).text()).toBe('body:https://app.test/')
    })

    it('creates no release caches when the network fails before the boot download', async () => {
        const storage = new FakeCaches()
        const active = await loadWorker({ version: 'pancake-active', storage })
        await active.install()
        await active.activate()
        for (let attempt = 0; attempt < 3; attempt++) {
            const offline = await loadWorker({ version: `pancake-offline-${attempt}`, storage, fetchImpl: async () => { throw new TypeError('Failed to fetch') } })
            await expect(offline.install()).rejects.toThrow('Failed to fetch')
            expect(offline.skipWaitingCalls).toBe(0)
        }
        expect((await storage.keys()).sort()).toEqual(['pancake-active-public-v1-assets', 'pancake-active-public-v1-shell'])
    })

    it('reuses one cache pair when the same release retries a failed install', async () => {
        const storage = new FakeCaches()
        const open = storage.open.bind(storage)
        let refuse = true
        vi.spyOn(storage, 'open').mockImplementation(async (name) => {
            const cache = await open(name)
            if (refuse && name.startsWith('pancake-retry-')) cache.put = async () => { throw new Error('QuotaExceededError') }
            return cache
        })
        for (let attempt = 0; attempt < 12; attempt++) {
            const retry = await loadWorker({ version: 'pancake-retry', storage })
            await expect(retry.install()).rejects.toThrow('QuotaExceededError')
        }
        expect((await storage.keys()).sort()).toEqual(['pancake-retry-public-v1-assets', 'pancake-retry-public-v1-shell'])
        refuse = false
        storage.stores.clear()
        const recovered = await loadWorker({ version: 'pancake-retry', storage })
        await recovered.install()
        expect(recovered.skipWaitingCalls).toBe(1)
    })

    it('waits for a pending carry write before requesting activation', async () => {
        const url = '/_expo/static/js/web/chunk.js'
        const body = 'verified lazy module'
        const worker = await loadWorker({ hashes: { [url]: createHash('sha256').update(body).digest('hex') } })
        const old = await worker.caches.open('pancake-old-public-v1-assets')
        await old.put(url, script(body))
        const current = await worker.caches.open('pancake-test-1-public-v1-assets')
        const original = current.put.bind(current)
        let release!: () => void
        const barrier = new Promise<void>(resolve => { release = resolve })
        let entered = false
        vi.spyOn(current, 'put').mockImplementation(async (key, value) => {
            if (key === url) { entered = true; await barrier }
            return original(key, value)
        })
        const installing = worker.install()
        await vi.waitFor(() => expect(entered).toBe(true))
        expect(worker.skipWaitingCalls).toBe(0)
        expect(await (await old.match(url))?.text()).toBe(body)
        expect(await current.match(url)).toBeUndefined()
        release()
        await installing
        expect(await (await current.match(url))?.text()).toBe(body)
        expect(worker.skipWaitingCalls).toBe(1)
    })

    it('rejects oversized untrusted carry bytes without discarding the old cache', async () => {
        const url = '/_expo/static/js/web/chunk.js'
        const worker = await loadWorker({ hashes: { [url]: 'not-the-build-digest' } })
        const old = await worker.caches.open('pancake-old-public-v1-assets')
        await old.put(url, new Response(new Uint8Array(64 * 1024 * 1024 + 1)))
        await expect(worker.install()).rejects.toThrow('byte limit')
        expect(worker.skipWaitingCalls).toBe(0)
        expect(await worker.caches.keys()).toContain('pancake-old-public-v1-assets')
    })

    it('preserves the old release when cache storage cannot be read for carryover', async () => {
        const worker = await loadWorker()
        const old = await worker.caches.open('pancake-old-public-v1-assets')
        await old.put('/_expo/static/js/web/chunk.js', script('saved'))
        vi.spyOn(worker.caches, 'keys').mockRejectedValue(new Error('storage denied'))
        await expect(worker.install()).rejects.toThrow('storage denied')
        expect(worker.skipWaitingCalls).toBe(0)
        expect(await (await old.match('/_expo/static/js/web/chunk.js'))?.text()).toBe('saved')
    })


    it('reuses a loaded boot asset only after checking its release digest', async () => {
        const requests: Request[] = []
        const asset = 'https://app.test/_expo/static/js/web/app.js'
        const httpCache = new Map([[asset, new Response(`body:${asset}`)]])
        let downloads = 0
        const worker = await loadWorker({ fetchImpl: async input => {
            const request = input as Request
            requests.push(request)
            const cached = ['force-cache', 'only-if-cached'].includes(request.cache) ? httpCache.get(request.url) : undefined
            if (request.cache === 'only-if-cached' && !cached) return new Response(null, { status: 504 })
            if (cached) return cached.clone()
            if (request.url === asset) downloads++
            return new Response(`body:${request.url}`, {
                headers: { 'content-type': new URL(request.url).pathname === '/' ? 'text/html' : 'application/javascript' },
            })
        } })
        await worker.install()
        expect(downloads).toBe(0)
        const cachedRequest = requests.find(request => request.url === asset)!
        expect(cachedRequest.credentials).toBe('omit')
        expect(cachedRequest.mode).toBe('same-origin')
        expect(cachedRequest.redirect).toBe('error')
        const assets = await worker.caches.open('pancake-test-1-public-v1-assets')
        expect(await (await assets.match('/_expo/static/js/web/app.js'))?.text()).toBe(`body:${asset}`)
        expect(worker.skipWaitingCalls).toBe(1)
    })

    it.each(['private', 'wrong-bytes', 'miss', 'unsupported'] as const)(
        'refetches boot assets when the HTTP cache is %s', async kind => {
            let downloads = 0
            const worker = await loadWorker({ fetchImpl: async input => {
                const request = input as Request
                if (['force-cache', 'only-if-cached'].includes(request.cache) && kind !== 'miss') {
                    if (kind === 'unsupported') throw new TypeError('Unsupported cache mode')
                    return new Response(kind === 'wrong-bytes' ? 'private user bytes' : `body:${request.url}`, {
                        headers: { 'cache-control': kind === 'private' ? 'private' : 'public' },
                    })
                }
                if (request.cache === 'only-if-cached') return new Response(null, { status: 504 })
                if (new URL(request.url).pathname !== '/') downloads++
                return new Response(`body:${request.url}`, {
                    headers: { 'content-type': new URL(request.url).pathname === '/' ? 'text/html' : 'application/javascript' },
                })
            } })
            await worker.install()
            expect(downloads).toBe(1)
            const assets = await worker.caches.open('pancake-test-1-public-v1-assets')
            expect(await (await assets.match('/_expo/static/js/web/app.js'))?.text()).toBe('body:https://app.test/_expo/static/js/web/app.js')
            expect(worker.skipWaitingCalls).toBe(1)
        },
    )
    it('does not redownload verified mutable boot assets or shell on warm launches', async () => {
        const manifest = '/manifest.webmanifest'
        const worker = await loadWorker({ precache: ['/', manifest] })
        await worker.install()
        worker.fetches.length = 0
        await worker.respond(scoped(manifest))
        await worker.respond(navigation('/players'))
        expect(worker.fetches).toEqual([])
    })

    it('recovers an absent old shell from anonymous online HTML without caching it as the old release', async () => {
        const requests: Request[] = []
        const worker = await loadWorker({ fetchImpl: async input => {
            requests.push(input as Request)
            return new Response('<!doctype html><title>Next release</title>', { headers: { 'content-type': 'text/html' } })
        } })
        expect(await (await worker.respond(navigation('/players'))).text()).toContain('Next release')
        expect((await worker.caches.open('pancake-test-1-public-v1-shell')).entries.size).toBe(0)
        expect(requests.every(request => request.credentials === 'omit')).toBe(true)
    })

    it.each(['http', 'cache-storage'])('rejects poisoned runtime bytes from %s', async source => {
        const url = '/_expo/static/js/web/chunk.js'
        const body = 'verified runtime script'
        const worker = await loadWorker({
            hashes: { [url]: createHash('sha256').update(body).digest('hex') },
            fetchImpl: async () => script(source === 'http' ? 'poisoned' : body),
        })
        const cache = await worker.caches.open('pancake-test-1-public-v1-assets')
        if (source === 'cache-storage') await cache.put(url, script('poisoned'))
        const response = await worker.respond(scoped(url))
        if (source === 'http') {
            expect(response.status).toBe(502)
            expect(await cache.match(url)).toBeUndefined()
        } else {
            expect(await response.text()).toBe(body)
            expect(await (await cache.match(scoped(url)))?.text()).toBe(body)
        }
    })

    it('reports push rotation to same-origin windows without sending a notification or storing an endpoint', async () => {
        const listeners = new Map<string, (event: { waitUntil: (promise: Promise<unknown>) => void }) => void>()
        const owned = { url: 'https://app.test/players', postMessage: vi.fn() }
        const foreign = { url: 'https://other.test/', postMessage: vi.fn() }
        const scope = {
            location: { origin: 'https://app.test' },
            addEventListener: (type: string, listener: (event: { waitUntil: (promise: Promise<unknown>) => void }) => void) => listeners.set(type, listener),
            clients: { matchAll: async () => [owned, foreign] },
        }
        new Function('self', await readFile('public/sw.js', 'utf8'))(scope)
        const pending: Promise<unknown>[] = []
        listeners.get('pushsubscriptionchange')!({ waitUntil: promise => pending.push(promise) })
        await Promise.all(pending)
        expect(owned.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'PANCAKE_PUSH_SUBSCRIPTION_CHANGED' })
        expect(foreign.postMessage).not.toHaveBeenCalled()
    })

    it('rejects a poisoned runtime response when CacheStorage is unavailable', async () => {
        const url = '/_expo/static/js/web/chunk.js'
        const worker = await loadWorker({
            hashes: { [url]: createHash('sha256').update('verified script').digest('hex') },
            fetchImpl: async () => script('poisoned'),
        })
        vi.spyOn(worker.caches, 'open').mockRejectedValue(new Error('Storage unavailable'))
        expect((await worker.respond(scoped(url))).status).toBe(502)
    })

})

it('waits to activate while another tab holds an editor', async () => {
    const worker = await loadWorker({ clients: [{ url: 'https://app.test/claim-player', postMessage: (_message, ports) => { ports[0].postMessage({ held: true, confirmationRecoveryVersion: 1 }); ports[0].close() } }] })
    await worker.install()
    expect(worker.skipWaitingCalls).toBe(0)
})

it('keeps an older page with a real hold waiting until it closes', async () => {
    const clients = [{ url: 'https://app.test/', postMessage: (_message: unknown, ports: MessagePort[]) => { ports[0].postMessage({ held: true }); ports[0].close() } }]
    const worker = await loadWorker({ clients })
    await worker.install()
    expect(worker.skipWaitingCalls).toBe(0)
    clients.splice(0)
    const pending: Promise<unknown>[] = []
    worker.listeners.get('message')!({ data: { type: 'PANCAKE_ACTIVATE_WHEN_SAFE' }, waitUntil: promise => pending.push(promise), respondWith: () => {} })
    await Promise.all(pending)
    expect(worker.skipWaitingCalls).toBe(1)
})

it('allows a recoverable create confirmation to update', async () => {
    const worker = await loadWorker({ clients: [{ url: 'https://app.test/create-league', postMessage: (_message, ports) => { ports[0].postMessage({ held: false, confirmationRecoveryVersion: 1 }); ports[0].close() } }] })
    await worker.install()
    expect(worker.skipWaitingCalls).toBe(1)
})

it('keeps a recoverable tab waiting for a held older same-origin tab', async () => {
    const clients = [
        { url: 'https://app.test/', postMessage: (_message: unknown, ports: MessagePort[]) => { ports[0].postMessage({ held: true }); ports[0].close() } },
        { url: 'https://app.test/profile', postMessage: (_message: unknown, ports: MessagePort[]) => { ports[0].postMessage({ held: false, confirmationRecoveryVersion: 1 }); ports[0].close() } },
        { url: 'https://other.test/', postMessage: vi.fn() },
    ]
    const worker = await loadWorker({ clients })
    await worker.install()
    expect(worker.skipWaitingCalls).toBe(0)
    clients.splice(0, 1)
    const pending: Promise<unknown>[] = []
    worker.listeners.get('message')!({ data: { type: 'PANCAKE_ACTIVATE_WHEN_SAFE' }, waitUntil: promise => pending.push(promise), respondWith: () => {} })
    await Promise.all(pending)
    expect(worker.skipWaitingCalls).toBe(1)
    expect(clients[1].postMessage).not.toHaveBeenCalled()
})

it('keeps verified installation usable when claiming clients fails', async () => {
    const storage = new FakeCaches()
    await storage.open('pancake-previous-public-v1-shell')
    const worker = await loadWorker({ storage, claimFailure: true })
    await worker.install()
    await expect(worker.activate()).resolves.toBeUndefined()
    expect(await storage.keys()).toContain('pancake-previous-public-v1-shell')
})

it('does not reject activation when obsolete cache cleanup fails', async () => {
    const storage = new FakeCaches()
    await storage.open('pancake-previous-public-v1-shell')
    const worker = await loadWorker({ storage })
    await worker.install()
    vi.spyOn(storage, 'delete').mockRejectedValue(new Error('Storage busy'))
    await expect(worker.activate()).resolves.toBeUndefined()
    expect(worker.claimCalls).toBe(1)
})

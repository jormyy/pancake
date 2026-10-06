import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// public/sw.js ships as-is to the browser, so nothing type checks or exercises
// it. Load it into a stand-in ServiceWorkerGlobalScope and drive its events.

type Listener = (event: WorkerEvent) => void
type WorkerEvent = { request?: Request; waitUntil: (p: Promise<unknown>) => void; respondWith: (r: unknown) => void }

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
    { fetchImpl, version = 'pancake-test-1', precache = ['/', '/_expo/static/js/web/app.js'], hashes = {}, allowed }:
    { fetchImpl?: (input: Request | string) => Promise<Response>; version?: string; precache?: string[]; hashes?: Record<string, string>; allowed?: string[] } = {},
): Promise<Harness> {
    let source = await readFile(path.join(process.cwd(), 'public/sw.js'), 'utf8')
    source = source
        .replace(/const VERSION = '[^']*'/, `const VERSION = '${version}'`)
        .replace(/const PRECACHE_URLS = \[[^\]]*\]/, `const PRECACHE_URLS = ${JSON.stringify(precache)}`)
        .replace(/const PUBLIC_ASSET_URLS = \[[^\n]*\]/, `const PUBLIC_ASSET_URLS = ${JSON.stringify(allowed ?? [...precache.filter(p => p !== '/'), '/_expo/static/js/web/chunk.js', '/_expo/static/js/web/old-chunk.js', '/manifest.webmanifest'])}`)
        .replace(/const SHELL_ROUTES = \[[^\n]*\]/, "const SHELL_ROUTES = ['/', '/players', '/player/[id]']")

    source = source.replace(/const PUBLIC_ASSET_HASHES = \{[^\n]*\}/, `const PUBLIC_ASSET_HASHES = ${JSON.stringify({ ...Object.fromEntries(precache.map(url => [url, createHash('sha256').update(`body:https://app.test${url}`).digest('hex')])), ...hashes })}`)

    const listeners = new Map<string, Listener>()
    const cacheStorage = new FakeCaches()
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
        clients: { claim: async () => { harness.claimCalls += 1 } },
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

        expect(response.status).toBe(200)
        const assets = await worker.caches.open('pancake-test-1-public-v1-assets')
        expect(assets.entries.size).toBe(0)
    })

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

    it.each(['asset', 'shell'])('keeps the %s refresh alive until its cache write finishes', async (kind) => {
        const response = new Response('updated', { headers: { 'content-type': kind === 'shell' ? 'text/html' : 'application/manifest+json' } })
        Object.defineProperty(response, 'type', { value: 'basic' })
        const worker = await loadWorker({ fetchImpl: async () => response, hashes: { '/': createHash('sha256').update('updated').digest('hex') } })
        const cache = await worker.caches.open(`pancake-test-1-public-v1-${kind === 'shell' ? 'shell' : 'assets'}`)
        const request = kind === 'shell' ? navigation('/') : scoped('/manifest.webmanifest')
        const key = kind === 'shell' ? '/' : request
        await cache.put(key, new Response('cached'))

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
        const pending: Promise<unknown>[] = []
        let result: unknown
        worker.listeners.get('fetch')!({
            request,
            waitUntil: (promise) => { pending.push(promise) },
            respondWith: (promise) => { result = promise },
        })
        const cached = await result as Response
        expect(await cached.text()).toBe('cached')
        await started
        expect(pending).toHaveLength(1)
        let finished = false
        const lifetime = Promise.all(pending).then(() => { finished = true })
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(finished).toBe(false)
        releaseWrite()
        await lifetime
        expect(await (await cache.match(key))?.text()).toBe('updated')
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
        ['/assets/unknown.js', {}], ['/_expo/static/js/web/chunk.js?account=A', {}],
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
        const worker = await loadWorker({ fetchImpl: async () => { throw new TypeError('offline') } })
        await (await worker.caches.open('pancake-test-1-public-v1-shell')).put('/', html())
        for (const route of ['/players/?tab=saved', '/player/fixture-player?view=stats']) {
            expect(await (await worker.respond(navigation(route))).text()).toContain('Not found')
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
                    if (request.cache !== 'only-if-cached') throw new TypeError('offline')
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

    it.each([['shell', 503], ['shell', 404], ['asset', 503], ['asset', 404]] as const)(
        'retains a valid public %s after a %s background refresh', async (kind, status) => {
            const worker = await loadWorker({ fetchImpl: async () => new Response('unavailable', { status }) })
            const cache = await worker.caches.open(`pancake-test-1-public-v1-${kind === 'shell' ? 'shell' : 'assets'}`)
            const request = kind === 'shell' ? navigation('/') : scoped('/manifest.webmanifest')
            const key = kind === 'shell' ? '/' : request
            await cache.put(key, new Response('public cached content'))
            expect(await (await worker.respond(request)).text()).toBe('public cached content')
            expect(await (await cache.match(key))?.text()).toBe('public cached content')
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
        const worker = await loadWorker({ fetchImpl: async () => new Response('new shell missing its chunk', { headers: { 'content-type': 'text/html' } }) })
        const shell = await worker.caches.open('pancake-test-1-public-v1-shell')
        await shell.put('/', new Response('old shell', { headers: { 'content-type': 'text/html' } }))
        expect(await (await worker.respond(navigation('/'))).text()).toBe('old shell')
        expect(await (await shell.match('/'))?.text()).toBe('old shell')
        await shell.delete('/')
        await expect(worker.respond(navigation('/'))).rejects.toThrow(/shell precache rejected/)
    })

})

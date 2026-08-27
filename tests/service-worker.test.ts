import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// public/sw.js ships as-is to the browser, so nothing type checks or exercises
// it. Load it into a stand-in ServiceWorkerGlobalScope and drive its events.

type Listener = (event: WorkerEvent) => void
type WorkerEvent = { request?: Request; waitUntil: (p: Promise<unknown>) => void; respondWith: (r: unknown) => void }

class FakeCache {
    entries = new Map<string, string>()
    async put(request: Request | string, response: Response) {
        this.entries.set(typeof request === 'string' ? request : request.url, await response.text())
    }
    async match(request: Request | string) {
        const key = typeof request === 'string' ? request : request.url
        const body = this.entries.get(key) ?? this.entries.get(new URL(key, 'https://app.test').pathname)
        return body === undefined ? undefined : new Response(body)
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
}

async function loadWorker(
    { fetchImpl, version = 'pancake-test-1', precache = ['/', '/_expo/static/js/web/app.js'] }:
    { fetchImpl?: (input: Request | string) => Promise<Response>; version?: string; precache?: string[] } = {},
): Promise<Harness> {
    let source = await readFile(path.join(process.cwd(), 'public/sw.js'), 'utf8')
    source = source
        .replace(/const VERSION = '[^']*'/, `const VERSION = '${version}'`)
        .replace(/const PRECACHE_URLS = \[[^\]]*\]/, `const PRECACHE_URLS = ${JSON.stringify(precache)}`)

    const listeners = new Map<string, Listener>()
    const cacheStorage = new FakeCaches()
    const fetches: string[] = []
    const harness = { listeners, caches: cacheStorage, fetches, skipWaitingCalls: 0, claimCalls: 0 } as Harness

    const fakeFetch = async (input: Request | string) => {
        const url = typeof input === 'string' ? input : input.url
        fetches.push(new URL(url, 'https://app.test').pathname)
        if (fetchImpl) return fetchImpl(input)
        return new Response(`body:${url}`, { status: 200 })
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
    harness.install = drive('install')
    harness.activate = drive('activate')
    return harness
}

describe('service worker', () => {
    beforeEach(() => vi.restoreAllMocks())

    it('precaches every declared boot asset on install', async () => {
        const worker = await loadWorker()
        await worker.install()

        expect(worker.fetches).toEqual(expect.arrayContaining(['/', '/_expo/static/js/web/app.js']))
        const assets = await worker.caches.open('pancake-test-1-assets')
        expect(assets.entries.size).toBe(1)
        const shell = await worker.caches.open('pancake-test-1-shell')
        expect(shell.entries.size).toBe(1)
        expect(worker.skipWaitingCalls).toBe(1)
    })

    it('skips a manifest entry the host no longer serves', async () => {
        const worker = await loadWorker({
            precache: ['/', '/_expo/static/js/web/gone.js'],
            fetchImpl: async (input) => {
                const url = typeof input === 'string' ? input : input.url
                return url.includes('gone.js')
                    ? new Response('missing', { status: 404 })
                    : new Response('body', { status: 200 })
            },
        })

        await expect(worker.install()).resolves.toBeUndefined()
        const assets = await worker.caches.open('pancake-test-1-assets')
        expect(assets.entries.size).toBe(0)
        expect(worker.skipWaitingCalls).toBe(1)
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
        await worker.install()

        await worker.activate()

        expect((await worker.caches.keys()).sort()).toEqual([
            'pancake-test-1-assets',
            'pancake-test-1-shell',
        ])
        expect(worker.claimCalls).toBe(1)
    })
})

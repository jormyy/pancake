import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'

const html = '<html><head><script type="module">globalThis.__EXPO_ROUTER_HYDRATE__=true;</script></head><body><div id="root">Home</div></body></html>'
const origin = 'http://127.0.0.1:56690'

async function serveRoute(pathname: string) {
    const stored = new Response(html, { headers: { 'content-type': 'text/html', 'content-length': String(html.length), 'content-encoding': 'gzip', etag: 'home-document' } })
    const cache = { match: async () => stored.clone(), delete: vi.fn() }
    const offline = vi.fn(async () => { throw new Error('offline') })
    const listeners = new Map<string, (event: unknown) => void>()
    const source = (await readFile('public/sw.js', 'utf8'))
        .replace('const PUBLIC_ASSET_HASHES = {}', `const PUBLIC_ASSET_HASHES = ${JSON.stringify({ '/': createHash('sha256').update(html).digest('hex') })}`)
        .replace("const SHELL_ROUTES = ['/']", "const SHELL_ROUTES = ['/', '/sign-in', '/sign-up', '/profile', '/player/[id]']")
    new Function('self', 'caches', 'fetch', source)({
        location: { origin },
        addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
    }, { open: async () => cache }, offline)
    const request = new Request(new URL(pathname, origin))
    Object.defineProperty(request, 'mode', { value: 'navigate' })
    let result!: Promise<Response>
    listeners.get('fetch')!({ request, waitUntil: () => {}, respondWith: (value: Promise<Response>) => { result = value } })
    return { response: await result, stored, offline }
}

it.each(['/sign-in', '/sign-up', '/profile', '/player/local-fixture'])('mounts %s without hydrating cached Home markup', async pathname => {
    const { response, stored, offline } = await serveRoute(pathname)
    expect(await response.text()).toBe(html.replace('__EXPO_ROUTER_HYDRATE__=true', '__EXPO_ROUTER_HYDRATE__=false'))
    expect(await stored.text()).toBe(html)
    expect(response.headers.has('content-length')).toBe(false)
    expect(response.headers.has('content-encoding')).toBe(false)
    expect(response.headers.has('etag')).toBe(false)
    expect(offline).not.toHaveBeenCalled()
})

it('keeps Home hydration and the stored document intact', async () => {
    const { response, stored, offline } = await serveRoute('/')
    expect(await response.text()).toBe(html)
    expect(await stored.text()).toBe(html)
    expect(response.headers.get('etag')).toBe('home-document')
    expect(offline).not.toHaveBeenCalled()
})

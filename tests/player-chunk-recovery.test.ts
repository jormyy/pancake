import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

const script = readFileSync('app/+html.tsx', 'utf8').split("const SW_REGISTER = process.env.NODE_ENV === 'production' ? `")[1].split('` : `')[0]
    .replace(/\$\{[^}]+\}/g, 'inherit')

function boot({ held = false, recoverable = false, online = true, previous = null as string | null, worker = false } = {}) {
    const events = new Map<string, (event?: unknown) => void>()
    const workerEvents = new Map<string, (event: unknown) => void>()
    const elements = new Map<string, ReturnType<typeof element>>()
    function element() {
        const result = { id: '', textContent: '', disabled: false, style: { cssText: '' }, children: [] as unknown[],
            setAttribute: vi.fn(), addEventListener: vi.fn(), appendChild: (child: unknown) => result.children.push(child), querySelector: () => result.children[0] }
        return result
    }
    const ports: { onmessage?: (event: unknown) => void; close: ReturnType<typeof vi.fn> }[] = []
    const reload = vi.fn()
    const storage = new Map<string, string>()
    if (previous) storage.set('pancake-update-reload:/players', previous)
    const scope = {
        window: { isSecureContext: true, __pancakePwaHolds: new Set(held ? [recoverable ? { canRecover: () => true } : 'draft'] : []), location: { pathname: '/players', reload }, addEventListener: (name: string, fn: (event?: unknown) => void) => events.set(name, fn) },
        navigator: { onLine: online, ...(worker ? { serviceWorker: { controller: { postMessage: vi.fn() }, addEventListener: (name: string, fn: (event: unknown) => void) => workerEvents.set(name, fn) } } : {}) },
        document: { readyState: 'complete', visibilityState: 'visible', querySelector: () => ({ content: 'build-old' }), addEventListener: vi.fn(), createElement: element,
            getElementById: (id: string) => elements.get(id), body: { appendChild: (node: ReturnType<typeof element>) => elements.set(node.id, node) } },
        sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
        setTimeout: vi.fn(), clearTimeout: vi.fn(), setInterval: vi.fn(), MessageChannel: class { port1 = { close: vi.fn() }; port2 = {}; constructor() { ports.push(this.port1) } },
    }
    runInNewContext(script, scope)
    return { events, workerEvents, reload, elements, scope, storage, reconcile: (draftRecoveryVersion?: number) => {
        workerEvents.get('controllerchange')?.({})
        ports.at(-1)?.onmessage?.({ data: { version: 'build-target', draftRecoveryVersion } })
    } }
}

it.each([
    { message: 'Loading bundle failed: /_expo/static/js/web/[id]-old.js' },
    { reason: new Error('Failed to fetch dynamically imported module') },
    { target: { tagName: 'SCRIPT', src: 'https://app.test/_expo/static/js/web/[id]-old.js' } },
    { message: "Unexpected token '<'", filename: 'https://app.test/_expo/static/js/web/[id]-old.js' },
])('recovers a failed route without a controlling worker: %j', event => {
    const f = boot()
    f.events.get('error')?.(event)
    expect(f.reload).toHaveBeenCalledOnce()
    expect(f.elements.get('pancake-update-notice')?.textContent).toBe('Updating…')
})

it('keeps unsent work and recovers as soon as the hold ends', () => {
    const f = boot({ held: true })
    f.events.get('error')?.({ target: { tagName: 'SCRIPT', src: 'https://app.test/_expo/static/js/web/old.js' } })
    expect(f.reload).not.toHaveBeenCalled()
    expect(f.elements.get('pancake-update-notice')?.textContent).toContain('Finish your current work')
    f.scope.window.__pancakePwaHolds.clear()
    f.events.get('pancake-pwa-hold-change')?.()
    expect(f.reload).toHaveBeenCalledOnce()
})

it('stops automatic reload loops and offers a manual retry', () => {
    const f = boot({ previous: 'build-old:asset-retry' })
    f.events.get('error')?.({ reason: new Error('ChunkLoadError') })
    expect(f.reload).not.toHaveBeenCalled()
    expect(f.elements.get('pancake-update-notice')?.textContent).toContain('Reload')
})

it('keeps a visible recovery action while offline', () => {
    const f = boot({ online: false })
    f.events.get('error')?.({ reason: new Error('ChunkLoadError') })
    expect(f.reload).not.toHaveBeenCalled()
    expect(f.elements.get('pancake-update-notice')?.textContent).toContain('Reconnect')
    f.scope.navigator.onLine = true
    f.events.get('online')?.()
    expect(f.reload).toHaveBeenCalledOnce()
})

it('ignores unrelated application failures', () => {
    const f = boot()
    f.events.get('error')?.({ message: 'Cannot read property of undefined' })
    expect(f.reload).not.toHaveBeenCalled()
    expect(f.elements.size).toBe(0)
})

it('recovers a missing chunk when the open draft is safely stored', () => {
    const f = boot({ held: true, recoverable: true, worker: true })
    f.reconcile(1)
    f.events.get('error')?.({ reason: new Error('ChunkLoadError') })
    expect(f.reload).toHaveBeenCalledOnce()
})

it('never reloads a saved draft while a mutation is still active', () => {
    const f = boot({ held: true, recoverable: true, worker: true })
    f.reconcile(1)
    f.scope.window.__pancakePwaHolds.add('active mutation')
    f.events.get('error')?.({ reason: new Error('ChunkLoadError') })
    expect(f.reload).not.toHaveBeenCalled()
    f.scope.window.__pancakePwaHolds.delete('active mutation')
    f.events.get('pancake-pwa-hold-change')?.()
    expect(f.reload).toHaveBeenCalledOnce()
})

it('holds a saved draft when the rollback worker cannot restore it', () => {
    const f = boot({ held: true, recoverable: true, worker: true })
    f.reconcile()
    f.events.get('error')?.({ reason: new Error('ChunkLoadError') })
    expect(f.reload).not.toHaveBeenCalled()
    expect(f.elements.get('pancake-update-notice')?.textContent).toContain('Finish your current work')
    f.scope.window.__pancakePwaHolds.clear()
    f.events.get('pancake-pwa-hold-change')?.()
    expect(f.reload).toHaveBeenCalledOnce()
})

it('holds a saved draft when there is no verified recovery target', () => {
    const f = boot({ held: true, recoverable: true })
    f.events.get('error')?.({ reason: new Error('ChunkLoadError') })
    expect(f.reload).not.toHaveBeenCalled()
})

it('does not reuse recovery support while a replacement worker is still unknown', () => {
    const f = boot({ held: true, recoverable: true, worker: true })
    f.reconcile(1)
    f.workerEvents.get('controllerchange')?.({})
    f.events.get('error')?.({ reason: new Error('ChunkLoadError') })
    expect(f.reload).not.toHaveBeenCalled()
})

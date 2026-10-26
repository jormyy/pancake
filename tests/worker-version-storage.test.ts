import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync('app/+html.tsx', 'utf8')
const script = source.split("const SW_REGISTER = process.env.NODE_ENV === 'production' ? `")[1].split('` : `')[0]

async function fixture(failure?: 'getter' | 'read' | 'write', previous: string | null = null, reloadMarker = previous) {
    const windowEvents = new Map<string, () => void>()
    const workerEvents = new Map<string, () => void>()
    const documentEvents = new Map<string, () => void>()
    const timers: (() => void)[] = []
    const ports: { onmessage: ((event: { data: { version: string } }) => void) | null; close: ReturnType<typeof vi.fn> }[] = []
    const reload = vi.fn()
    const denied = () => { throw new DOMException('Storage denied', 'SecurityError') }
    const storage = {
        removeItem: vi.fn(),
        getItem: vi.fn((key: string) => failure === 'read' ? denied() : key.startsWith('pancake-update-reload:') ? reloadMarker : previous),
        setItem: vi.fn((_key: string, _value: string) => { if (failure === 'write') denied() }),
    }
    const worker = { postMessage: vi.fn() }
    const scope = {
        window: { isSecureContext: true, __pancakePwaHolds: new Set<string>(), addEventListener: (name: string, fn: () => void) => windowEvents.set(name, fn), location: { pathname: '/', reload } },
        document: { visibilityState: 'visible', getElementById: vi.fn(), addEventListener: (name: string, fn: () => void) => documentEvents.set(name, fn) },
        navigator: { serviceWorker: { controller: worker, register: async () => ({ active: worker, update: async () => {} }), addEventListener: (name: string, fn: () => void) => workerEvents.set(name, fn) } },
        MessageChannel: class {
            port1 = { onmessage: null, close: vi.fn() }
            port2 = {}
            constructor() { ports.push(this.port1) }
        },
        setInterval: vi.fn(),
        setTimeout: (fn: () => void, delay: number) => { expect([10000, 60000]).toContain(delay); timers.push(fn) },
    }
    Object.defineProperty(scope, 'sessionStorage', { get: () => failure === 'getter' ? denied() : storage })
    runInNewContext(script, scope)
    windowEvents.get('load')?.()
    await Promise.resolve()
    return { scope, visibilityChange: () => documentEvents.get('visibilitychange')?.(), releaseHold: () => { scope.window.__pancakePwaHolds.clear(); windowEvents.get('pancake-pwa-hold-change')?.() }, ports, timers, reload, storage, worker, pagehide: () => windowEvents.get('pagehide')?.(), controllerChange: () => workerEvents.get('controllerchange')?.(), reply: (version: string, index = 0) => ports[index].onmessage?.({ data: { version } }) }
}

describe('worker release version storage', () => {
    it.each(['getter', 'read', 'write'] as const)('settles a version reply safely when storage %s fails', async failure => {
        const f = await fixture(failure, 'old')
        expect(() => f.reply('next')).not.toThrow()
        expect(f.ports[0].close).toHaveBeenCalledOnce()
        expect(f.reload).not.toHaveBeenCalled()
        expect(() => f.timers[0]()).not.toThrow()
        expect(() => f.reply('late')).not.toThrow()
        expect(f.ports[0].close).toHaveBeenCalledOnce()
    })

    it.each([null, 'same'])('records a first or unchanged version without reloading (%s)', async previous => {
        const f = await fixture(undefined, previous)
        f.reply('same')
        expect(f.storage.setItem).toHaveBeenCalledWith('pancake-sw-worker-version', 'same')
        expect(f.reload).not.toHaveBeenCalled()
        if (previous === 'same') expect(f.storage.removeItem).toHaveBeenCalledWith('pancake-update-reload:/')
        else expect(f.storage.removeItem).not.toHaveBeenCalled()
        expect(f.ports[0].close).toHaveBeenCalledOnce()
    })

    it('reloads once after a durably recorded changed release', async () => {
        const f = await fixture(undefined, 'old')
        f.reply('next')
        f.controllerChange()
        f.reply('newer', 1)
        expect(f.reload).toHaveBeenCalledOnce()
        expect(f.storage.setItem.mock.calls.filter(([key]) => key === 'pancake-sw-worker-version')).toHaveLength(1)
        expect(f.storage.setItem).toHaveBeenCalledWith('pancake-update-reload:/', 'next')
        expect(f.worker.postMessage.mock.calls[0][0]).toEqual({ type: 'PANCAKE_WORKER_VERSION' })
        expect(Array.isArray(f.worker.postMessage.mock.calls[0][1])).toBe(true)
        expect(f.worker.postMessage.mock.calls[0][1]).toHaveLength(1)
    })

    it('waits until the app returns to the foreground', async () => {
        const f = await fixture(undefined, 'old')
        f.scope.document.visibilityState = 'hidden'
        f.reply('next')
        f.pagehide()
        expect(f.reload).not.toHaveBeenCalled()
        f.scope.document.visibilityState = 'visible'
        f.visibilityChange()
        expect(f.reload).toHaveBeenCalledOnce()
    })

    it('preserves an open editor through backgrounding and reloads after it closes', async () => {
        const f = await fixture(undefined, 'old')
        f.scope.window.__pancakePwaHolds.add('claim')
        f.reply('next')
        f.scope.document.visibilityState = 'hidden'
        f.visibilityChange()
        f.pagehide()
        f.scope.document.visibilityState = 'visible'
        f.visibilityChange()
        expect(f.reload).not.toHaveBeenCalled()
        f.releaseHold()
        expect(f.reload).toHaveBeenCalledOnce()
    })

    it('does not reset a failed chunk retry when the worker version is unchanged', async () => {
        const f = await fixture(undefined, 'same', 'same:asset-retry')
        f.reply('same')
        expect(f.storage.removeItem).not.toHaveBeenCalled()
        expect(f.reload).not.toHaveBeenCalled()
    })

    it('ignores a late reply after timeout without touching denied storage', async () => {
        const f = await fixture('getter')
        f.timers[0]()
        expect(() => f.reply('late')).not.toThrow()
        expect(f.ports[0].close).toHaveBeenCalledOnce()
        expect(f.reload).not.toHaveBeenCalled()
    })
})

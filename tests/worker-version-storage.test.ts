import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync('app/+html.tsx', 'utf8')
const script = source.split("const SW_REGISTER = process.env.NODE_ENV === 'production' ? `")[1].split('` : `')[0]

async function fixture(failure?: 'getter' | 'read' | 'write', previous: string | null = null) {
    const windowEvents = new Map<string, () => void>()
    const workerEvents = new Map<string, () => void>()
    const timers: (() => void)[] = []
    const ports: { onmessage: ((event: { data: { version: string } }) => void) | null; close: ReturnType<typeof vi.fn> }[] = []
    const reload = vi.fn()
    const denied = () => { throw new DOMException('Storage denied', 'SecurityError') }
    const storage = {
        getItem: vi.fn(() => failure === 'read' ? denied() : previous),
        setItem: vi.fn(() => { if (failure === 'write') denied() }),
    }
    const worker = { postMessage: vi.fn() }
    const scope = {
        window: { isSecureContext: true, addEventListener: (name: string, fn: () => void) => windowEvents.set(name, fn), location: { reload } },
        document: { visibilityState: 'visible', addEventListener: vi.fn() },
        navigator: { serviceWorker: { controller: worker, register: async () => ({ active: worker, update: async () => {} }), addEventListener: (name: string, fn: () => void) => workerEvents.set(name, fn) } },
        MessageChannel: class {
            port1 = { onmessage: null, close: vi.fn() }
            port2 = {}
            constructor() { ports.push(this.port1) }
        },
        setInterval: vi.fn(),
        setTimeout: (fn: () => void, delay: number) => { expect(delay).toBe(10000); timers.push(fn) },
    }
    Object.defineProperty(scope, 'sessionStorage', { get: () => failure === 'getter' ? denied() : storage })
    runInNewContext(script, scope)
    windowEvents.get('load')?.()
    await Promise.resolve()
    return { ports, timers, reload, storage, worker, controllerChange: () => workerEvents.get('controllerchange')?.(), reply: (version: string, index = 0) => ports[index].onmessage?.({ data: { version } }) }
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
        expect(f.ports[0].close).toHaveBeenCalledOnce()
    })

    it('reloads once after a durably recorded changed release', async () => {
        const f = await fixture(undefined, 'old')
        f.reply('next')
        f.controllerChange()
        f.reply('newer', 1)
        expect(f.reload).toHaveBeenCalledOnce()
        expect(f.storage.setItem).toHaveBeenCalledTimes(2)
        expect(f.worker.postMessage.mock.calls[0][0]).toEqual({ type: 'PANCAKE_WORKER_VERSION' })
        expect(Array.isArray(f.worker.postMessage.mock.calls[0][1])).toBe(true)
        expect(f.worker.postMessage.mock.calls[0][1]).toHaveLength(1)
    })

    it('ignores a late reply after timeout without touching denied storage', async () => {
        const f = await fixture('getter')
        f.timers[0]()
        expect(() => f.reply('late')).not.toThrow()
        expect(f.ports[0].close).toHaveBeenCalledOnce()
        expect(f.reload).not.toHaveBeenCalled()
    })
})

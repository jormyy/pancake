import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'

type Message = { data: { type: string }; ports: { postMessage: (value: unknown) => void }[]; waitUntil: (promise: Promise<unknown>) => void }
class ActiveWorker extends EventTarget {
    constructor(public state: ServiceWorkerState) { super() }
    transition(next: ServiceWorkerState) { this.state = next; this.dispatchEvent(new Event('statechange')) }
}
async function askVersion(active: ActiveWorker | null) {
    const listeners = new Map<string, (event: Message) => void>()
    const scope = { registration: { active }, addEventListener: (type: string, callback: (event: Message) => void) => listeners.set(type, callback) }
    new Function('self', await readFile('public/sw.js', 'utf8'))(scope)
    const reply = vi.fn()
    const pending: Promise<unknown>[] = []
    listeners.get('message')!({ data: { type: 'PANCAKE_WORKER_VERSION' }, ports: [{ postMessage: reply }], waitUntil: promise => pending.push(promise) })
    return { reply, done: Promise.all(pending) }
}

describe('worker version replies follow native activation', () => {
    it('withholds a reply before activation starts, then replies once activation completes', async () => {
        const active = new ActiveWorker('activating')
        const remove = vi.spyOn(active, 'removeEventListener')
        const request = await askVersion(active)
        expect(request.reply).not.toHaveBeenCalled()
        active.transition('activated')
        await request.done
        expect(request.reply).toHaveBeenCalledExactlyOnceWith({ version: 'pancake-dev', draftRecoveryVersion: 1 })
        expect(remove).toHaveBeenCalledWith('statechange', expect.any(Function))
        active.transition('redundant')
        expect(request.reply).toHaveBeenCalledTimes(1)
    })

    it('answers an already activated worker after a restart without another activate event', async () => {
        const request = await askVersion(new ActiveWorker('activated'))
        await request.done
        expect(request.reply).toHaveBeenCalledExactlyOnceWith({ version: 'pancake-dev', draftRecoveryVersion: 1 })
    })

    it('settles a replaced worker without telling a waiting page to reload', async () => {
        const active = new ActiveWorker('activating')
        const remove = vi.spyOn(active, 'removeEventListener')
        const request = await askVersion(active)
        active.transition('redundant')
        await request.done
        expect(request.reply).not.toHaveBeenCalled()
        expect(remove).toHaveBeenCalledWith('statechange', expect.any(Function))
    })

    it('settles without a reply when the registration has no active worker', async () => {
        const request = await askVersion(null)
        await request.done
        expect(request.reply).not.toHaveBeenCalled()
    })
})

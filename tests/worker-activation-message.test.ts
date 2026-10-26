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

async function requestActivation(answers: (Record<string, unknown> | undefined)[], activate: () => Promise<void> = async () => {}) {
    const listeners = new Map<string, (event: Message) => void>()
    const skipWaiting = vi.fn(activate)
    const clients = answers.map(answer => ({
        url: 'https://app.test/players',
        postMessage: (_message: unknown, ports: MessagePort[]) => {
            if (answer !== undefined) ports[0].postMessage(answer)
            ports[0].close()
        },
    }))
    const scope = { clients: { matchAll: async () => clients }, location: { origin: 'https://app.test' }, skipWaiting,
        addEventListener: (type: string, callback: (event: Message) => void) => listeners.set(type, callback) }
    new Function('self', await readFile('public/sw.js', 'utf8'))(scope)
    const pending: Promise<unknown>[] = []
    listeners.get('message')!({ data: { type: 'PANCAKE_ACTIVATE_WHEN_SAFE' }, ports: [], waitUntil: promise => pending.push(promise) })
    await Promise.all(pending)
    return skipWaiting
}

describe('activation respects every window hold', () => {
    it.each([
        { name: 'legacy idle', answer: { held: false }, activates: true },
        { name: 'legacy hold', answer: { held: true }, activates: false },
        { name: 'unanswered', answer: undefined, activates: false },
        { name: 'current idle', answer: { held: false, confirmationRecoveryVersion: 1 }, activates: true },
        { name: 'current hold', answer: { held: true, confirmationRecoveryVersion: 1 }, activates: false },
        { name: 'invalid reply', answer: {}, activates: false },
    ])('$name', async ({ answer, activates }) => {
        expect(await requestActivation([answer])).toHaveBeenCalledTimes(activates ? 1 : 0)
    })

    it('finishes the activation message before native activation settles', async () => {
        const nativeActivation = new Promise<void>(() => {})
        let timer: ReturnType<typeof setTimeout>
        try {
            const settled = await Promise.race([
                requestActivation([{ held: false }], () => nativeActivation).then(() => true),
                new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 500) }),
            ])
            expect(settled).toBe(true)
        } finally { clearTimeout(timer!) }
    })

    it('keeps a peer hold even when the requesting legacy window is idle', async () => {
        expect(await requestActivation([{ held: false }, { held: true, confirmationRecoveryVersion: 1 }])).not.toHaveBeenCalled()
    })
})

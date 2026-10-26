import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { requestPwaReload } from '@/lib/pwa-update-guard'

const script = readFileSync('app/+html.tsx', 'utf8').split("const SW_REGISTER = process.env.NODE_ENV === 'production' ? `")[1].split('` : `')[0].replace(/\$\{[^}]+\}/g, 'inherit')

async function boot(waiting = true) {
    const window = new EventTarget() as EventTarget & { isSecureContext: boolean; location: { pathname: string; reload: ReturnType<typeof vi.fn> }; __pancakePwaHolds: Map<string, unknown> }
    Object.assign(window, { isSecureContext: true, location: { pathname: '/players', reload: vi.fn() }, __pancakePwaHolds: new Map() })
    const workerEvents = new Map<string, () => void>()
    const candidate = { postMessage: vi.fn() }
    const registration = { waiting: waiting ? candidate : null, active: null, update: vi.fn(async () => {}), addEventListener: vi.fn() }
    const worker = { postMessage: vi.fn() }
    const ports: { onmessage?: (event: unknown) => void }[] = []
    const buttons: { click?: () => void }[] = []
    const element = () => ({ id: '', style: {}, setAttribute: vi.fn(), appendChild: vi.fn(), addEventListener: (type: string, fn: () => void) => { if (type === 'click') buttons.push({ click: fn }) } })
    const serviceWorker = { controller: worker, register: async () => registration, addEventListener: (name: string, fn: () => void) => workerEvents.set(name, fn) }
    const scope = { window, navigator: { onLine: true, serviceWorker },
        document: { querySelector: () => ({ content: 'old' }), readyState: 'complete', visibilityState: 'visible', getElementById: () => null, createElement: element, body: { appendChild: vi.fn() }, addEventListener: vi.fn() },
        sessionStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }, setTimeout: vi.fn(), clearTimeout: vi.fn(), setInterval: vi.fn(),
        MessageChannel: class { port1 = { onmessage: undefined as ((event: unknown) => void) | undefined, close: vi.fn() }; port2 = {}; constructor() { ports.push(this.port1) } } }
    runInNewContext(script, scope)
    window.dispatchEvent(new Event('load'))
    await Promise.resolve()
    return { window, workerEvents, registration, candidate, buttons, ports, serviceWorker,
        reply: (version: string) => ports.at(-1)?.onmessage?.({ data: { version, draftRecoveryVersion: 1 } }),
        flush: async () => { for (let i = 0; i < 8; i++) await Promise.resolve() } }
}

afterEach(() => vi.unstubAllGlobals())

it.each(['route', 'notice'])('requests activation from the %s Reload action and waits for control', async action => {
    const f = await boot()
    vi.stubGlobal('window', f.window)
    if (action === 'route') requestPwaReload()
    else {
        f.window.dispatchEvent(new Event('pancake-pwa-reload', { cancelable: true }))
        f.buttons.at(-1)?.click?.()
    }
    await f.flush()
    expect(f.candidate.postMessage).toHaveBeenCalledWith({ type: 'PANCAKE_ACTIVATE_WHEN_SAFE' })
    expect(f.window.location.reload).not.toHaveBeenCalled()
    f.registration.waiting = null
    f.serviceWorker.controller = { postMessage: vi.fn() }
    f.workerEvents.get('controllerchange')?.()
    f.reply('candidate')
    expect(f.window.location.reload).toHaveBeenCalledOnce()
    f.workerEvents.get('controllerchange')?.()
    f.reply('candidate')
    expect(f.window.location.reload).toHaveBeenCalledOnce()
})

it('reloads directly after checking a registration with no waiting worker', async () => {
    const f = await boot(false)
    vi.stubGlobal('window', f.window)
    requestPwaReload()
    await f.flush()
    f.reply('old')
    expect(f.window.location.reload).toHaveBeenCalledOnce()
})

it('keeps active mutations blocking both manual and automatic recovery', async () => {
    const f = await boot()
    vi.stubGlobal('window', f.window)
    f.window.__pancakePwaHolds.set('mutation', { reason: 'mutation' })
    f.candidate.postMessage.mockClear()
    requestPwaReload()
    await f.flush()
    expect(f.window.location.reload).not.toHaveBeenCalled()
    expect(f.candidate.postMessage).not.toHaveBeenCalled()
    f.window.__pancakePwaHolds.clear()
    f.window.dispatchEvent(new Event('pancake-pwa-hold-change'))
    expect(f.candidate.postMessage).toHaveBeenCalled()
})

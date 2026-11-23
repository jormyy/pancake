export type LifecycleEvent = 'online' | 'offline' | 'visible' | 'hidden' | 'focus' | 'rejoin'

type Listener = (event: LifecycleEvent) => void

const REJOIN_COALESCE_MS = 250
const rejoinListeners = new Set<() => void>()
let rejoinTimer: ReturnType<typeof setTimeout> | null = null

export function isOnline(): boolean {
    return typeof navigator === 'undefined' || navigator.onLine !== false
}

function isVisible(): boolean {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

export function readsAllowed(): boolean {
    return isOnline() && isVisible()
}

export function onLifecycle(events: readonly LifecycleEvent[], listener: Listener): () => void {
    const wanted = new Set(events)
    const target = typeof window !== 'undefined' ? window : null
    const page = typeof document !== 'undefined' ? document : null
    const bindings: [EventTarget, string, () => void][] = []
    const bind = (on: EventTarget | null, name: string, handler: () => void) => {
        if (!on) return
        on.addEventListener(name, handler)
        bindings.push([on, name, handler])
    }
    if (wanted.has('online')) bind(target, 'online', () => listener('online'))
    if (wanted.has('offline')) bind(target, 'offline', () => listener('offline'))
    if (wanted.has('focus')) {
        bind(target, 'focus', () => listener('focus'))
        bind(target, 'pageshow', () => listener('focus'))
    }
    if (wanted.has('visible') || wanted.has('hidden')) bind(page, 'visibilitychange', () => {
        const event = isVisible() ? 'visible' : 'hidden'
        if (wanted.has(event)) listener(event)
    })
    const rejoin = () => listener('rejoin')
    if (wanted.has('rejoin')) rejoinListeners.add(rejoin)
    return () => {
        for (const [on, name, handler] of bindings.splice(0)) on.removeEventListener(name, handler)
        rejoinListeners.delete(rejoin)
    }
}

export function announceRejoin(): void {
    if (rejoinTimer) return
    rejoinTimer = setTimeout(() => {
        rejoinTimer = null
        for (const rejoin of [...rejoinListeners]) rejoin()
    }, REJOIN_COALESCE_MS)
}

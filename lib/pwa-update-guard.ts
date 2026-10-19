type UpdateWindow = Window & { __pancakePwaHolds?: Map<symbol, string> }

export function holdPwaUpdate(reason: string): () => void {
    if (typeof window === 'undefined') return () => {}
    const target = window as UpdateWindow
    const holds = target.__pancakePwaHolds ??= new Map()
    const token = Symbol(reason)
    holds.set(token, reason)
    return () => {
        if (holds.delete(token)) target.dispatchEvent(new Event('pancake-pwa-hold-change'))
    }
}

export function isPwaUpdateHeld(): boolean {
    return typeof window !== 'undefined' && !!(window as UpdateWindow).__pancakePwaHolds?.size
}

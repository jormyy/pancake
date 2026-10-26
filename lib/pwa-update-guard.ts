type UpdateWindow = Window & { __pancakePwaHolds?: Map<symbol, { reason: string; canRecover?: () => boolean }> }

export function holdPwaUpdate(reason: string, canRecover?: () => boolean): () => void {
    if (typeof window === 'undefined') return () => {}
    const target = window as UpdateWindow
    const holds = target.__pancakePwaHolds ??= new Map()
    const token = Symbol(reason)
    holds.set(token, { reason, canRecover })
    target.dispatchEvent(new Event('pancake-pwa-hold-change'))
    return () => {
        if (holds.delete(token)) target.dispatchEvent(new Event('pancake-pwa-hold-change'))
    }
}

export function isPwaUpdateHeld(): boolean {
    return typeof window !== 'undefined' && !!(window as UpdateWindow).__pancakePwaHolds?.size
}

import { useCallback, useEffect, useRef, useState } from 'react'

export function browserReadsAllowed(): boolean {
    return (typeof document === 'undefined' || document.visibilityState !== 'hidden')
        && (typeof navigator === 'undefined' || navigator.onLine !== false)
}

export function useBrowserReadActivity() {
    const [activity, setActivity] = useState(() => ({ active: browserReadsAllowed(), revision: 0 }))
    const current = useRef(activity)
    useEffect(() => {
        const update = () => {
            const active = browserReadsAllowed()
            if (current.current.active === active) return
            current.current = { active, revision: current.current.revision + 1 }
            setActivity(current.current)
        }
        update()
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', update)
        if (typeof window !== 'undefined') {
            window.addEventListener('online', update)
            window.addEventListener('offline', update)
        }
        return () => {
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', update)
            if (typeof window !== 'undefined') {
                window.removeEventListener('online', update)
                window.removeEventListener('offline', update)
            }
        }
    }, [])
    const isCurrent = useCallback((revision: number) => current.current.revision === revision && browserReadsAllowed(), [])
    return { ...activity, isCurrent }
}

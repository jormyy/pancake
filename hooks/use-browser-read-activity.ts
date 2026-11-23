import { useCallback, useEffect, useRef, useState } from 'react'
import { onLifecycle, readsAllowed } from '@/lib/lifecycle'

export function useBrowserReadActivity() {
    const [activity, setActivity] = useState(() => ({ active: readsAllowed(), revision: 0 }))
    const current = useRef(activity)
    useEffect(() => {
        const update = () => {
            const active = readsAllowed()
            if (current.current.active === active) return
            current.current = { active, revision: current.current.revision + 1 }
            setActivity(current.current)
        }
        update()
        return onLifecycle(['visible', 'hidden', 'online', 'offline'], update)
    }, [])
    const isCurrent = useCallback((revision: number) => current.current.revision === revision && readsAllowed(), [])
    return { ...activity, isCurrent }
}

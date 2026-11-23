import { useEffect, useState } from 'react'
import { isOnline, onLifecycle } from '@/lib/lifecycle'

export function useOnlineStatus(): boolean {
    const [online, setOnline] = useState(isOnline)
    useEffect(() => {
        const update = () => { setOnline(isOnline()) }
        update()
        return onLifecycle(['online', 'offline'], update)
    }, [])
    return online
}

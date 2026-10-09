import { useEffect, useState } from 'react'

function browserOnline(): boolean {
    return typeof navigator === 'undefined' || navigator.onLine !== false
}

export function useOnlineStatus(): boolean {
    const [online, setOnline] = useState(browserOnline)
    useEffect(() => {
        if (typeof window === 'undefined') return
        const update = () => { setOnline(browserOnline()) }
        window.addEventListener('online', update)
        window.addEventListener('offline', update)
        update()
        return () => {
            window.removeEventListener('online', update)
            window.removeEventListener('offline', update)
        }
    }, [])
    return online
}

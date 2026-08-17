import { useEffect, useState } from 'react'
import { Platform } from 'react-native'

function browserOnline(): boolean {
    return Platform.OS !== 'web' || typeof navigator === 'undefined' || navigator.onLine
}

export function useOnlineStatus(): boolean {
    const [online, setOnline] = useState(browserOnline)

    useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return
        const update = () => setOnline(browserOnline())
        window.addEventListener('online', update)
        window.addEventListener('offline', update)
        return () => {
            window.removeEventListener('online', update)
            window.removeEventListener('offline', update)
        }
    }, [])

    return online
}

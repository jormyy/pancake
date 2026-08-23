import { useNetworkState } from 'expo-network'
import { Platform } from 'react-native'
import { useEffect, useState } from 'react'

function browserOnline(): boolean {
    return Platform.OS !== 'web' || typeof navigator === 'undefined' || navigator.onLine
}

export function useOnlineStatus(): boolean {
    const state = useNetworkState()
    const [webOnline, setWebOnline] = useState(browserOnline)

    useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return
        const update = () => { setWebOnline(browserOnline()) }
        window.addEventListener('online', update)
        window.addEventListener('offline', update)
        update()
        return () => {
            window.removeEventListener('online', update)
            window.removeEventListener('offline', update)
        }
    }, [])

    if (Platform.OS === 'web') return webOnline
    if (state.isConnected === false || state.isInternetReachable === false) return false
    return webOnline
}

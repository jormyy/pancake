import { addNetworkStateListener, getNetworkStateAsync } from 'expo-network'
import { AppState, Platform } from 'react-native'
import { useEffect, useState } from 'react'

function browserOnline(): boolean {
    return typeof navigator === 'undefined' || navigator.onLine
}

export function useOnlineStatus(): boolean {
    const [online, setOnline] = useState(() => Platform.OS === 'web' && browserOnline())

    useEffect(() => {
        if (Platform.OS === 'web') {
            if (typeof window === 'undefined') return
            const update = () => { setOnline(browserOnline()) }
            window.addEventListener('online', update)
            window.addEventListener('offline', update)
            update()
            return () => {
                window.removeEventListener('online', update)
                window.removeEventListener('offline', update)
            }
        }

        let disposed = false
        let revision = 0
        let timer: ReturnType<typeof setTimeout> | undefined
        const cancelPending = () => {
            revision += 1
            clearTimeout(timer)
        }
        const refresh = async () => {
            const request = ++revision
            try {
                const state = await getNetworkStateAsync()
                if (!disposed && request === revision) {
                    setOnline(state.isConnected === true && state.isInternetReachable === true)
                }
            } catch {
                if (!disposed && request === revision) setOnline(false)
            }
        }
        const subscription = addNetworkStateListener((state) => {
            cancelPending()
            if (state.isConnected === false || state.isInternetReachable === false) setOnline(false)
            // Android can report the previous default network inside onLost.
            // Read again after the transition, without a recurring poll.
            timer = setTimeout(() => { void refresh() }, 250)
        })
        const foreground = AppState.addEventListener('change', (state) => {
            cancelPending()
            if (state === 'active') void refresh()
        })
        void refresh()
        return () => {
            disposed = true
            cancelPending()
            subscription.remove()
            foreground.remove()
        }
    }, [])

    return online
}

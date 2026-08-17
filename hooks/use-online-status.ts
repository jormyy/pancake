import { useNetworkState } from 'expo-network'
import { Platform } from 'react-native'

function browserOnline(): boolean {
    return Platform.OS !== 'web' || typeof navigator === 'undefined' || navigator.onLine
}

export function useOnlineStatus(): boolean {
    const state = useNetworkState()
    if (state.isConnected === false || state.isInternetReachable === false) return false
    return browserOnline()
}

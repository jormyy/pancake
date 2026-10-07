import { useEffect, useRef, useState } from 'react'
import { AppState, Platform } from 'react-native'

type ResumeReason = 'initial-online' | 'reconnect' | 'foreground'

/** Revalidates visible native resources after the OS network state settles. */
export function useNativeResourceResume(
    online: boolean,
    focused: boolean,
    revalidate: (reason: ResumeReason) => void,
) {
    const [active, setActive] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive')
    const callback = useRef(revalidate)
    callback.current = revalidate
    const hasConnected = useRef(online)
    const pending = useRef<ResumeReason | null>(null)

    useEffect(() => {
        if (Platform.OS === 'web') return
        let previous = AppState.currentState
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active' && previous !== 'active' && pending.current !== 'reconnect') {
                pending.current = 'foreground'
            }
            previous = state
            setActive(state === 'active')
        })
        return () => { subscription.remove() }
    }, [])

    useEffect(() => {
        if (Platform.OS === 'web') return
        if (!online) pending.current = hasConnected.current ? 'reconnect' : 'initial-online'
        else hasConnected.current = true
        if (!online || !active || !focused || !pending.current) return
        // Coalesce foreground and the connectivity hook's settled network read.
        const timer = setTimeout(() => {
            const reason = pending.current
            pending.current = null
            if (reason) callback.current(reason)
        }, 300)
        return () => { clearTimeout(timer) }
    }, [active, focused, online])
}

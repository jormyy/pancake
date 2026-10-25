import { useCallback, useRef } from 'react'
import { Platform, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'

type Touch = { nativeEvent: { touches: readonly { pageX: number; pageY: number }[] } }
type Scroll = NativeSyntheticEvent<NativeScrollEvent>
type Pull = { x: number; y: number; distance: number }

export function usePullToRefresh(onRefresh: (() => void | Promise<void>) | undefined, refreshing = false, onScroll?: (event: Scroll) => void) {
    const latest = useRef({ onRefresh, refreshing, onScroll })
    latest.current = { onRefresh, refreshing, onScroll }
    const state = useRef({ offset: 0, pull: null as Pull | null, pending: false })
    const handleScroll = useCallback((event: Scroll) => {
        state.current.offset = event.nativeEvent.contentOffset.y
        if (state.current.offset > 0) state.current.pull = null
        latest.current.onScroll?.(event)
    }, [])
    const onTouchStart = useCallback((event: Touch) => {
        const touches = event.nativeEvent.touches
        state.current.pull = Platform.OS === 'web' && touches.length === 1 && state.current.offset <= 0
            && !state.current.pending && !latest.current.refreshing && latest.current.onRefresh
            ? { x: touches[0].pageX, y: touches[0].pageY, distance: 0 } : null
    }, [])
    const onTouchMove = useCallback((event: Touch) => {
        const pull = state.current.pull
        const touches = event.nativeEvent.touches
        if (!pull) return
        if (touches.length !== 1 || Math.abs(touches[0].pageX - pull.x) > 24) {
            state.current.pull = null
            return
        }
        pull.distance = touches[0].pageY - pull.y
    }, [])
    const onTouchEnd = useCallback(() => {
        const pull = state.current.pull
        state.current.pull = null
        const refresh = latest.current.onRefresh
        if (!pull || pull.distance < 80 || !refresh || latest.current.refreshing || state.current.pending) return
        state.current.pending = true
        void Promise.resolve().then(refresh)
            .catch(error => console.error('Could not refresh this screen.', error))
            .finally(() => { state.current.pending = false })
    }, [])
    const onTouchCancel = useCallback(() => { state.current.pull = null }, [])
    return { onScroll: handleScroll, onTouchStart, onTouchMove, onTouchEnd, onTouchCancel }
}

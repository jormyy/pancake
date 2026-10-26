import { useIsFocused } from '@react-navigation/native'
import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native'
import { onSessionCachesCleared } from '@/lib/session-cache-registry'

type ScrollTarget = {
    scrollTo?: (options: { y: number; animated: boolean }) => void
    scrollToOffset?: (options: { offset: number; animated: boolean }) => void
}

const positions = new Map<string, number>()
onSessionCachesCleared(() => positions.clear())

export function useScrollRestoration(key: string, target: RefObject<ScrollTarget | null>) {
    const focused = useIsFocused()
    const pending = useRef<number | null>(positions.get(key) ?? null)
    const viewportHeight = useRef(0)
    const contentHeight = useRef(0)
    const restore = useCallback(() => {
        const offset = pending.current
        if (!focused || offset === null || !target.current || !viewportHeight.current || contentHeight.current < offset + viewportHeight.current) return
        if (target.current.scrollToOffset) target.current.scrollToOffset({ offset, animated: false })
        else target.current.scrollTo?.({ y: offset, animated: false })
        pending.current = null
    }, [focused, target])

    useLayoutEffect(() => {
        pending.current = positions.get(key) ?? null
        restore()
    }, [key, focused, restore])

    const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (!focused || pending.current !== null) return
        positions.delete(key)
        positions.set(key, event.nativeEvent.contentOffset.y)
        if (positions.size > 40) positions.delete(positions.keys().next().value!)
    }, [focused, key])
    const onLayout = useCallback((event: LayoutChangeEvent) => {
        viewportHeight.current = event.nativeEvent.layout.height
        restore()
    }, [restore])
    const onContentSizeChange = useCallback((_width: number, height: number) => {
        contentHeight.current = height
        restore()
    }, [restore])

    return { onScroll, onLayout, onContentSizeChange, scrollEventThrottle: 16 }
}

import { useCallback, useRef, useState } from 'react'
import { Platform, StyleSheet, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { webMasks } from '@/constants/tokens'

/**
 * Fades the edges of a sideways scroll strip while more content sits past
 * them, so a cut-off item reads as "swipe for more". Spread `scrollProps` on
 * the ScrollView and add `fadeStyle` to its style.
 */
export function useEdgeFade(onLayoutExtra?: () => void) {
    const sizes = useRef({ viewport: 0, content: 0, x: 0 })
    const [edges, setEdges] = useState({ left: false, right: false })
    const update = useCallback(() => {
        const { viewport, content, x } = sizes.current
        const left = x > 1
        const right = content - x - viewport > 1
        setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }))
    }, [])

    const scrollProps = {
        onLayout: (event: LayoutChangeEvent) => {
            sizes.current.viewport = event.nativeEvent.layout.width
            onLayoutExtra?.()
            update()
        },
        onContentSizeChange: (width: number) => {
            sizes.current.content = width
            update()
        },
        onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
            sizes.current.x = event.nativeEvent.contentOffset.x
            update()
        },
        scrollEventThrottle: 32,
    }

    const fadeStyle = Platform.OS !== 'web'
        ? null
        : edges.left && edges.right ? styles.fadeBoth : edges.right ? styles.fadeRight : edges.left ? styles.fadeLeft : null

    return { fadeStyle, scrollProps, scrollX: sizes }
}

const styles = StyleSheet.create({
    fadeRight: { maskImage: webMasks.fadeRight, WebkitMaskImage: webMasks.fadeRight } as object,
    fadeLeft: { maskImage: webMasks.fadeLeft, WebkitMaskImage: webMasks.fadeLeft } as object,
    fadeBoth: { maskImage: webMasks.fadeBoth, WebkitMaskImage: webMasks.fadeBoth } as object,
})

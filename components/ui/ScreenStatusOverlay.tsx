import { createContext, forwardRef, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Platform, ScrollView, StyleSheet, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewProps, type StyleProp, type ViewStyle } from 'react-native'
import { breakpoints, colors, spacing } from '@/constants/tokens'

const StatusContext = createContext({ inset: 0, bottom: 0, setVisible: (_visible: boolean) => {}, setHeight: (_height: number) => {} })

export function ScreenStatusProvider({ children }: { children: ReactNode }) {
    const { width } = useWindowDimensions()
    const [visible, setVisible] = useState(false)
    const [height, setHeight] = useState(44)
    const bottom = Platform.OS === 'web' && width >= breakpoints.compact ? 144 : 72
    const value = useMemo(() => ({ inset: visible ? bottom + height + spacing.sm : 0, bottom, setVisible, setHeight }), [visible, bottom, height])
    return <StatusContext.Provider value={value}>{children}</StatusContext.Provider>
}

export function ScreenStatusOverlay({ children }: { children?: ReactNode }) {
    const { bottom, setVisible, setHeight } = useContext(StatusContext)
    const visible = Boolean(children)
    useLayoutEffect(() => {
        setVisible(visible)
        return () => setVisible(false)
    }, [visible, setVisible])
    return (
        <View style={[styles.overlay, { bottom }]} pointerEvents={visible ? 'auto' : 'none'} testID="screen-status-notice" role="status" aria-live="polite" accessibilityLiveRegion="polite">
            {visible ? <View style={styles.notice} onLayout={event => setHeight(Math.ceil(event.nativeEvent.layout.height))}>{children}</View> : null}
        </View>
    )
}

export function useScreenStatusScroll() {
    const { inset } = useContext(StatusContext)
    const [paddingBottom, setPaddingBottom] = useState(inset)
    const metrics = useRef({ offset: 0, content: 0, viewport: 0 })
    const canReduce = useCallback((from: number, to: number) => {
        const { offset, content, viewport } = metrics.current
        return offset <= 0 || offset < Math.max(0, content - viewport - from + to) - 1
    }, [])
    useLayoutEffect(() => {
        setPaddingBottom(previous => inset >= previous || canReduce(previous, inset) ? inset : previous)
    }, [inset, canReduce])
    const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
        metrics.current = { offset: contentOffset.y, content: contentSize.height, viewport: layoutMeasurement.height }
        setPaddingBottom(previous => inset < previous && canReduce(previous, inset) ? inset : previous)
    }, [inset, canReduce])
    const contentStyle = useCallback((style?: StyleProp<ViewStyle>) => {
        if (!paddingBottom) return style
        const flat = StyleSheet.flatten(style)
        const existing = flat?.paddingBottom ?? flat?.paddingVertical ?? flat?.padding ?? 0
        return [style, { paddingBottom: (typeof existing === 'number' ? existing : 0) + paddingBottom }]
    }, [paddingBottom])
    return { paddingBottom, onScroll, contentStyle }
}

export const ScreenStatusScrollView = forwardRef<ScrollView, ScrollViewProps>(function ScreenStatusScrollView({ contentContainerStyle, onScroll, scrollEventThrottle = 16, ...props }, ref) {
    const status = useScreenStatusScroll()
    return <ScrollView {...props} ref={ref} contentContainerStyle={status.contentStyle(contentContainerStyle)} scrollEventThrottle={scrollEventThrottle} onScroll={event => { status.onScroll(event); onScroll?.(event) }} />
})

const styles = StyleSheet.create({
    overlay: { position: 'absolute', left: spacing.lg, right: spacing.lg, zIndex: 900 },
    notice: { minHeight: 44, backgroundColor: colors.bgScreen },
})

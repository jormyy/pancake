import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Platform, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native'
import { Pressable } from 'react-native'
import { colors, fontFamily, fontSize, fontWeight, motion, radii, spacing, webMasks, webOverlays } from '@/constants/tokens'
import { nextRovingIndex } from '@/components/ui/rovingFocus'
import { scheduleWebFocusRecovery, shouldRecoverFocus } from '@/components/ui/webFocus'

export type SegmentOption<T extends string> = {
    label: string
    value: T
    badge?: number
    accessibilityLabel?: string
}

type Props<T extends string> = {
    options: SegmentOption<T>[]
    value: T
    onChange: (value: T) => void
    accessibilityLabel?: string
    idBase?: string
    controlledPanelId?: string
    scrollable?: boolean
    /** `pills` filter a list; `tabs` switch between a page's sections. */
    variant?: 'pills' | 'tabs'
    style?: StyleProp<ViewStyle>
}

type PressableState = { hovered?: boolean; pressed?: boolean }
type WebKeyboardEvent = {
    key: string
    preventDefault?: () => void
}
type WebKeyDownProps = {
    onKeyDown?: (event: WebKeyboardEvent) => void
}

function focusSegment(idBase: string | undefined, value: string, shouldFocus: () => boolean): (() => void) | null {
    if (!idBase || Platform.OS !== 'web' || typeof document === 'undefined') return null
    const focus = () => {
        if (!shouldFocus()) return
        const target = document.getElementById(`${idBase}-${value}`)
        if (target instanceof HTMLElement && shouldRecoverFocus(target)) target.focus()
    }
    return scheduleWebFocusRecovery(focus)
}

/** The single tab-switcher / segmented-control primitive (Standings/Activity/…). */
export function SegmentedControl<T extends string>({
    options,
    value,
    onChange,
    accessibilityLabel = 'Filter options',
    idBase,
    controlledPanelId,
    scrollable = false,
    variant = 'pills',
    style,
}: Props<T>) {
    const tabs = variant === 'tabs'
    const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
    const effectiveIdBase = idBase ?? `segmented-${generatedId}`
    const pendingFocusValue = useRef<T | null>(null)
    const focusRequestId = useRef(0)
    const cancelFocusRecovery = useRef<(() => void) | null>(null)

    const scheduleSegmentFocus = useCallback((nextValue: T) => {
        const requestId = ++focusRequestId.current
        cancelFocusRecovery.current?.()
        cancelFocusRecovery.current = focusSegment(effectiveIdBase, nextValue, () => focusRequestId.current === requestId)
    }, [effectiveIdBase])

    useEffect(() => () => cancelFocusRecovery.current?.(), [])

    // Scrollable tracks keep the selected tab in view, so a deep link to a
    // far-right section never opens with its tab hidden off screen.
    const scrollRef = useRef<ScrollView>(null)
    const segmentLayouts = useRef<Record<string, { x: number; width: number }>>({})
    const viewportWidth = useRef(0)
    const contentWidth = useRef(0)
    const scrollX = useRef(0)
    const [moreToRight, setMoreToRight] = useState(false)
    const [moreToLeft, setMoreToLeft] = useState(false)
    const updateEdge = useCallback(() => {
        setMoreToRight(contentWidth.current - scrollX.current - viewportWidth.current > 1)
        setMoreToLeft(scrollX.current > 1)
    }, [])
    const edgeFade = moreToLeft && moreToRight ? styles.fadeBoth : moreToRight ? styles.fadeRight : moreToLeft ? styles.fadeLeft : null
    const scrollIntoView = useCallback((target: T) => {
        const box = segmentLayouts.current[target]
        const viewport = viewportWidth.current
        if (!scrollable || !box || viewport <= 0) return
        const pad = spacing.xl
        if (box.x < scrollX.current + pad) {
            scrollRef.current?.scrollTo({ x: Math.max(0, box.x - pad), animated: false })
        } else if (box.x + box.width > scrollX.current + viewport - pad) {
            scrollRef.current?.scrollTo({ x: box.x + box.width - viewport + pad, animated: false })
        }
    }, [scrollable])
    useEffect(() => { scrollIntoView(value) }, [scrollIntoView, value])

    useEffect(() => {
        if (pendingFocusValue.current !== value) return
        pendingFocusValue.current = null
        scheduleSegmentFocus(value)
    }, [scheduleSegmentFocus, value])

    function selectValue(nextValue: T) {
        pendingFocusValue.current = nextValue
        onChange(nextValue)
        scheduleSegmentFocus(nextValue)
    }

    function handleKeyDown(event: WebKeyboardEvent, index: number) {
        const nextIndex = nextRovingIndex(index, event.key, options.length)
        if (nextIndex == null) return

        event.preventDefault?.()
        selectValue(options[nextIndex].value)
    }

    const segments = options.map((opt, index) => {
        const active = opt.value === value
        const segmentLabel = opt.accessibilityLabel ?? (
            typeof opt.badge === 'number'
                ? `${opt.label}, ${opt.badge}`
                : opt.label
        )
        const webKeyProps: WebKeyDownProps = Platform.OS === 'web'
            ? { onKeyDown: (event) => handleKeyDown(event, index) }
            : {}
        return (
            <Pressable
                key={opt.value}
                nativeID={`${effectiveIdBase}-${opt.value}`}
                onPress={() => selectValue(opt.value)}
                role="tab"
                aria-label={segmentLabel}
                aria-selected={active}
                aria-controls={controlledPanelId}
                tabIndex={active ? 0 : -1}
                accessibilityRole="tab"
                accessibilityLabel={segmentLabel}
                accessibilityState={{ selected: active }}
                {...webKeyProps}
                onLayout={scrollable ? (event: LayoutChangeEvent) => {
                    segmentLayouts.current[opt.value] = { x: event.nativeEvent.layout.x, width: event.nativeEvent.layout.width }
                    if (opt.value === value) scrollIntoView(value)
                } : undefined}
                style={({ hovered, pressed }: PressableState) => tabs
                    ? [styles.tab, active && styles.tabActive, hovered && !active && styles.tabHover, pressed && styles.pressed]
                    : [styles.segment, active && styles.segmentActive, hovered && !active && styles.segmentHover, pressed && styles.pressed]}
            >
                <Text style={tabs ? [styles.tabLabel, active && styles.tabLabelActive] : [styles.label, active && styles.labelActive]} numberOfLines={1}>
                    {opt.label}
                </Text>
                {typeof opt.badge === 'number' && opt.badge > 0 ? (
                    <View style={tabs ? styles.tabBadge : [styles.badge, active && styles.badgeActive]}>
                        <Text style={tabs ? styles.tabBadgeText : [styles.badgeText, active && styles.badgeTextActive]}>{opt.badge}</Text>
                    </View>
                ) : null}
            </Pressable>
        )
    })

    if (scrollable) {
        return (
            <ScrollView
                ref={scrollRef}
                horizontal
                showsHorizontalScrollIndicator={false}
                style={[styles.scrollTrack, Platform.OS === 'web' && edgeFade]}
                onLayout={(event) => {
                    viewportWidth.current = event.nativeEvent.layout.width
                    scrollIntoView(value)
                    updateEdge()
                }}
                onContentSizeChange={(width) => {
                    contentWidth.current = width
                    updateEdge()
                }}
                onScroll={(event) => {
                    scrollX.current = event.nativeEvent.contentOffset.x
                    updateEdge()
                }}
                scrollEventThrottle={32}
                role="tablist"
                aria-label={accessibilityLabel}
                aria-orientation="horizontal"
                accessibilityRole="tablist"
                accessibilityLabel={accessibilityLabel}
                contentContainerStyle={[styles.track, tabs && styles.tabTrack, styles.trackScrollable, style]}
            >
                {segments}
            </ScrollView>
        )
    }

    return (
        <View
            style={[styles.track, tabs && styles.tabTrack, style]}
            role="tablist"
            aria-label={accessibilityLabel}
            aria-orientation="horizontal"
            accessibilityRole="tablist"
            accessibilityLabel={accessibilityLabel}
        >
            {segments}
        </View>
    )
}

const styles = StyleSheet.create({
    track: {
        flexDirection: 'row',
        gap: spacing.sm,
        alignItems: 'center',
        flexWrap: 'wrap',
    },
    trackScrollable: {
        flexWrap: 'nowrap',
    },
    // Clip to the space the parent gives, so a header action never sits on top of tabs.
    scrollTrack: { width: '100%', flexGrow: 0 },
    fadeRight: { maskImage: webMasks.fadeRight, WebkitMaskImage: webMasks.fadeRight } as object,
    fadeLeft: { maskImage: webMasks.fadeLeft, WebkitMaskImage: webMasks.fadeLeft } as object,
    fadeBoth: { maskImage: webMasks.fadeBoth, WebkitMaskImage: webMasks.fadeBoth } as object,
    segment: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.sm,
        minHeight: 44,
        paddingHorizontal: spacing.xl,
        borderRadius: radii['3xl'],
        backgroundColor: colors.bgMuted,
        borderCurve: 'continuous',
    },
    segmentActive: {
        backgroundColor: colors.primary,
    },
    segmentHover: { backgroundColor: colors.bgSubtle },
    pressed: { opacity: motion.pressedOpacity },
    label: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        fontFamily: fontFamily.displayMedium,
        color: colors.textSecondary,
    },
    labelActive: { color: colors.textWhite },
    tabTrack: { gap: spacing.xs },
    tab: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.sm,
        minHeight: 44,
        paddingHorizontal: spacing.lg,
        borderBottomWidth: 2,
        borderBottomColor: 'transparent',
    },
    tabActive: { borderBottomColor: colors.primary },
    tabHover: { borderBottomColor: colors.borderLight },
    tabLabel: {
        fontSize: fontSize.md,
        fontWeight: fontWeight.semibold,
        color: colors.textMuted,
    },
    tabLabelActive: { color: colors.primaryDark, fontWeight: fontWeight.bold },
    // Underline tabs have no filled background, so the count keeps one solid
    // style whether or not its tab is selected.
    tabBadge: {
        minWidth: 18,
        height: 18,
        paddingHorizontal: spacing.xs,
        borderRadius: radii.full,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.primary,
    },
    tabBadgeText: { fontSize: fontSize['2xs'], fontWeight: fontWeight.bold, color: colors.textWhite },
    badge: {
        minWidth: 18,
        height: 18,
        paddingHorizontal: 5,
        borderRadius: radii.full,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.bgCard,
    },
    badgeActive: { backgroundColor: webOverlays.navBadgeActive },
    badgeText: { fontSize: 10, fontWeight: fontWeight.bold, color: colors.textSecondary },
    badgeTextActive: { color: colors.textWhite },
})

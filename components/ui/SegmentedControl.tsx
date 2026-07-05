import { useCallback, useEffect, useId, useRef } from 'react'
import { Platform, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { Pressable } from 'react-native'
import { colors, fontFamily, fontSize, fontWeight, motion, radii, spacing, webOverlays } from '@/constants/tokens'
import { nextRovingIndex } from '@/components/ui/rovingFocus'
import { scheduleWebFocusRecovery } from '@/components/ui/webFocus'

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

const INTERACTIVE_ROLES = new Set(['button', 'checkbox', 'combobox', 'link', 'menuitem', 'radio', 'switch', 'textbox'])

function shouldRecoverFocus(target: HTMLElement) {
    const active = document.activeElement
    if (!active || active === target || active === document.body) return true
    if (!(active instanceof HTMLElement)) return false

    const role = active.getAttribute('role')
    if (role === 'tab') return true
    if (role && INTERACTIVE_ROLES.has(role)) return false
    if (['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) return false
    return !active.isContentEditable
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
    style,
}: Props<T>) {
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
                style={({ hovered, pressed }: PressableState) => [
                    styles.segment,
                    active && styles.segmentActive,
                    hovered && !active && styles.segmentHover,
                    pressed && styles.pressed,
                ]}
            >
                <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>
                    {opt.label}
                </Text>
                {typeof opt.badge === 'number' && opt.badge > 0 ? (
                    <View style={[styles.badge, active && styles.badgeActive]}>
                        <Text style={[styles.badgeText, active && styles.badgeTextActive]}>{opt.badge}</Text>
                    </View>
                ) : null}
            </Pressable>
        )
    })

    if (scrollable) {
        return (
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                role="tablist"
                aria-label={accessibilityLabel}
                aria-orientation="horizontal"
                accessibilityRole="tablist"
                accessibilityLabel={accessibilityLabel}
                contentContainerStyle={[styles.track, styles.trackScrollable, style]}
            >
                {segments}
            </ScrollView>
        )
    }

    return (
        <View
            style={[styles.track, style]}
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
    segment: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.sm,
        minHeight: 44,
        paddingHorizontal: spacing.xl,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.borderLight,
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

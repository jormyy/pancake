import { ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { Pressable } from 'react-native'
import { colors, fontSize, fontWeight, motion, radii, spacing } from '@/constants/tokens'

export type SegmentOption<T extends string> = {
    label: string
    value: T
    badge?: number
}

type Props<T extends string> = {
    options: SegmentOption<T>[]
    value: T
    onChange: (value: T) => void
    scrollable?: boolean
    style?: StyleProp<ViewStyle>
}

type PressableState = { hovered?: boolean; pressed?: boolean }

/** The single tab-switcher / segmented-control primitive (Standings/Activity/…). */
export function SegmentedControl<T extends string>({ options, value, onChange, scrollable = false, style }: Props<T>) {
    const segments = options.map((opt) => {
        const active = opt.value === value
        return (
            <Pressable
                key={opt.value}
                onPress={() => onChange(opt.value)}
                accessibilityRole="tab"
                accessibilityLabel={opt.label}
                accessibilityState={{ selected: active }}
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
                contentContainerStyle={[styles.track, style]}
            >
                {segments}
            </ScrollView>
        )
    }

    return (
        <View style={[styles.track, style]} accessibilityRole="tablist">
            {segments}
        </View>
    )
}

const styles = StyleSheet.create({
    track: {
        flexDirection: 'row',
        gap: spacing.sm,
        alignItems: 'center',
    },
    segment: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        minHeight: 36,
        paddingHorizontal: spacing.xl,
        borderRadius: radii.full,
        borderWidth: 1,
        borderColor: 'transparent',
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
    badgeActive: { backgroundColor: 'rgba(255, 255, 255, 0.28)' },
    badgeText: { fontSize: 10, fontWeight: fontWeight.bold, color: colors.textSecondary },
    badgeTextActive: { color: colors.textWhite },
})

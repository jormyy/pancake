import { View, Text, StyleSheet } from 'react-native'
import { INJURY_COLORS, colors, fontSize, fontWeight, radii } from '@/constants/tokens'

type Variant = 'solid' | 'soft'

type Props = {
    label: string
    /** Background color (solid) or tint color (soft — 13% opacity bg) */
    color?: string
    /** Text color override (defaults to white for solid, color for soft) */
    textColor?: string
    variant?: Variant
    maxWidth?: number
}

/** A player's injury status (Out, GTD…) in its status color; nothing when healthy. */
export function InjuryBadge({ status }: { status: string | null | undefined }) {
    if (!status) return null
    return <Badge label={status} color={INJURY_COLORS[status] ?? colors.textMuted} variant="solid" />
}

/** Small pill badge for status, injury, role, etc. */
export function Badge({
    label,
    color = colors.bgMuted,
    textColor,
    variant = 'soft',
    maxWidth,
}: Props) {
    const fg = textColor ?? (variant === 'solid' ? colors.textWhite : color)

    return (
        <View
            style={[
                styles.badge,
                variant === 'solid' && { backgroundColor: color },
                maxWidth ? { maxWidth } : undefined,
            ]}
        >
            {/* Soft tint via an opacity layer so any color works — including the
                CSS-var semantic tokens on web, which hex concatenation breaks. */}
            {variant === 'soft' ? (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: color, opacity: 0.13 }]} />
            ) : null}
            <Text style={[styles.text, { color: fg }]} numberOfLines={1}>
                {label}
            </Text>
        </View>
    )
}

const styles = StyleSheet.create({
    badge: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: radii.sm,
        borderCurve: 'continuous',
        overflow: 'hidden',
    },
    text: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
    },
})

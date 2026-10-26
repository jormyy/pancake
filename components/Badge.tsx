import { View, Text, StyleSheet } from 'react-native'
import { INJURY_COLORS, colors, controlSize, fontSize, fontWeight, radii, spacing, textStyles } from '@/constants/tokens'

type Variant = 'solid' | 'soft'

type Props = {
    label: string
    accessibilityLabel?: string
    /** Background color (solid) or tint color (soft — 13% opacity bg) */
    color?: string
    /** Text color override (defaults to white for solid, color for soft) */
    textColor?: string
    variant?: Variant
    inline?: boolean
    maxWidth?: number
}

/** A player's injury status (Out, GTD…) in its status color; nothing when healthy. */
export function InjuryBadge({ status }: { status: string | null | undefined }) {
    if (!status) return null
    const value = status.toLowerCase()
    const label = value === 'out' ? 'O' : ['day-to-day', 'gtd', 'dtd'].includes(value) ? 'DTD' : value === 'ir' ? 'IR' : status
    const accessibilityLabel = label === 'O' ? 'Out' : label === 'DTD' ? 'Day-To-Day' : label === 'IR' ? 'Injured reserve' : status
    const colorKey = label === 'O' ? 'Out' : label === 'IR' ? 'IR' : status
    return <Badge inline label={label} accessibilityLabel={accessibilityLabel} color={INJURY_COLORS[colorKey] ?? colors.textMuted} variant="solid" />
}

/** Small pill badge for status, injury, role, etc. */
export function Badge({
    label,
    accessibilityLabel,
    color = colors.bgMuted,
    textColor,
    variant = 'soft',
    maxWidth,
    inline = false,
}: Props) {
    const fg = textColor ?? (variant === 'solid' ? colors.textWhite : color)

    return (
        <View
            accessibilityLabel={accessibilityLabel}
            accessible={Boolean(accessibilityLabel)}
            style={[
                styles.badge,
                inline && styles.inline,
                inline && label.length === 1 && styles.inlineCircle,
                variant === 'solid' && { backgroundColor: color },
                maxWidth ? { maxWidth } : undefined,
            ]}
        >
            {/* Soft tint via an opacity layer so any color works — including the
                CSS-var semantic tokens on web, which hex concatenation breaks. */}
            {variant === 'soft' ? (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: color, opacity: 0.13 }]} />
            ) : null}
            <Text style={[styles.text, inline && styles.inlineText, { color: fg }]} numberOfLines={1}>
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
    inline: { height: controlSize.badge.height, paddingVertical: 0, paddingHorizontal: spacing.xxs, justifyContent: 'center', flexShrink: 0 },
    inlineCircle: { width: controlSize.badge.height, paddingHorizontal: 0, borderRadius: radii.full, alignItems: 'center' },
    inlineText: { lineHeight: textStyles.meta.lineHeight },
    text: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
    },
})

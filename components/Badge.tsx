import { View, Text, StyleSheet } from 'react-native'
import { colors, fontSize, fontWeight, radii } from '@/constants/tokens'

type Variant = 'solid' | 'soft'

type Props = {
    label: string
    /** Background color (solid) or tint color (soft — 15% opacity bg) */
    color?: string
    /** Text color override (defaults to white for solid, color for soft) */
    textColor?: string
    variant?: Variant
    maxWidth?: number
}

/** Small pill badge for status, injury, role, etc. */
export function Badge({
    label,
    color = colors.bgMuted,
    textColor,
    variant = 'soft',
    maxWidth,
}: Props) {
    const bg = variant === 'solid' ? color : color + '22'
    const fg = textColor ?? (variant === 'solid' ? colors.textWhite : color)

    return (
        <View style={[styles.badge, { backgroundColor: bg }, maxWidth ? { maxWidth } : undefined]}>
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
    },
    text: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
    },
})

import { View, Text, StyleSheet } from 'react-native'
import { getPositionColor } from '@/constants/positions'
import { alpha, colors, componentTokens } from '@/constants/tokens'

/**
 * Small position tag. The bright position colors fail WCAG AA as 9px text on
 * cream, so the color signal moves to a soft tinted pill while the label itself
 * uses the AA-clean dark text token.
 */
export function PosTag({ position }: { position: string }) {
    const color = getPositionColor(position)
    return (
        <View testID="position-chip" style={[styles.pill, { backgroundColor: alpha(color, 0.22), borderColor: alpha(color, 0.4) }]}>
            <Text style={styles.label}>{position}</Text>
        </View>
    )
}

const styles = StyleSheet.create({
    pill: {
        minHeight: componentTokens.badge.position.minHeight,
        paddingHorizontal: componentTokens.badge.position.paddingHorizontal,
        paddingVertical: componentTokens.badge.position.paddingVertical,
        borderRadius: componentTokens.badge.position.borderRadius,
        borderCurve: 'continuous',
        borderWidth: 1,
    },
    label: {
        ...componentTokens.badge.position.label,
        // Near-primary espresso so the small glyph is unambiguously legible on
        // the tint; the color signal lives in the pill fill + border.
        color: colors.textPrimary,
    },
})

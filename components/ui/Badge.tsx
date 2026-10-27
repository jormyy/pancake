import { View, Text, StyleSheet, type StyleProp, type ViewStyle, type TextStyle } from 'react-native'
import { colors, componentTokens, radii, textStyles } from '@/constants/tokens'

type Variant = 'solid' | 'soft'

type Props = {
    label: string | number | undefined
    accessibilityLabel?: string
    /** Background color (solid) or tint color (soft — 13% opacity bg) */
    color?: string
    /** Text color override (defaults to white for solid, color for soft) */
    textColor?: string
    variant?: Variant
    inline?: boolean
    size?: 'standard' | 'inline' | 'count' | 'status' | 'ownership' | 'small' | 'outlined'
    style?: StyleProp<ViewStyle>
    textStyle?: StyleProp<TextStyle>
    maxWidth?: number
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
    size,
    style,
    textStyle,
}: Props) {
    inline = size ? size === 'inline' : inline
    const fg = textColor ?? (variant === 'solid' ? colors.textWhite : color)

    return (
        <View
            accessibilityLabel={accessibilityLabel}
            accessible={Boolean(accessibilityLabel)}
            style={[
                styles.badge,
                inline && styles.inline,
                inline && String(label ?? '').length === 1 && styles.inlineCircle,
                variant === 'solid' && { backgroundColor: color },
                size === 'count' && styles.count,
                size === 'status' && componentTokens.badge.status,
                size === 'small' && componentTokens.badge.small,
                size === 'outlined' && componentTokens.badge.outlined,
                size === 'ownership' && styles.ownership,
                maxWidth ? { maxWidth } : undefined,
                style,
    textStyle,
            ]}
        >
            {/* Soft tint via an opacity layer so any color works — including the
                CSS-var semantic tokens on web, which hex concatenation breaks. */}
            {variant === 'soft' ? (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: color, opacity: componentTokens.badge.tintOpacity }]} />
            ) : null}
            <Text style={[styles.text, inline && styles.inlineText, (size === 'count' || size === 'small') && styles.countText, { color: fg }, textStyle]}>
                {label}
            </Text>
        </View>
    )
}

const styles = StyleSheet.create({
    badge: {
        ...componentTokens.badge.standard,
        borderCurve: 'continuous',
        overflow: 'hidden',
    },
    inline: { ...componentTokens.badge.inline, justifyContent: 'center', flexShrink: 0 },
    inlineCircle: { minWidth: componentTokens.badge.inline.minHeight, paddingHorizontal: 0, borderRadius: radii.full, alignItems: 'center' },
    ownership: { minHeight: componentTokens.badge.ownership.minHeight, paddingHorizontal: componentTokens.badge.ownership.paddingHorizontal, paddingVertical: componentTokens.badge.ownership.paddingVertical, borderRadius: componentTokens.badge.ownership.borderRadius, justifyContent: 'center', alignItems: 'center', flexShrink: 0 },
    count: { ...componentTokens.badge.count, justifyContent: 'center', alignItems: 'center' },
    countText: { ...componentTokens.badge.countLabel },
    inlineText: { lineHeight: textStyles.meta.lineHeight },
    text: {
        ...componentTokens.badge.label,
    },
})

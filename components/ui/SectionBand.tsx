import type { ComponentProps, ReactNode } from 'react'
import { View, Text, StyleSheet, type StyleProp, type TextStyle } from 'react-native'
import { borderWidth, colors, componentTokens } from '@/constants/tokens'

type Props = ComponentProps<typeof View> & {
    label: string
    detail?: ReactNode
    tone?: keyof typeof componentTokens.sectionBand.tones
    variant?: 'standard' | 'matchup' | 'action' | 'plain'
    labelStyle?: StyleProp<TextStyle>
}

export function SectionBand({ label, detail, tone = 'default', variant = 'standard', labelStyle, style, ...props }: Props) {
    const colors = componentTokens.sectionBand.tones[tone]
    return <View role="heading" aria-level={2} accessibilityRole="header" accessibilityLabel={label} {...props}
        style={[styles.band, { backgroundColor: colors.backgroundColor }, variant === 'matchup' && styles.matchup, variant === 'action' && [styles.matchup, styles.action], variant === 'plain' && styles.plain, style]}>
        <Text style={[styles.label, { color: colors.color }, labelStyle]}>{label}</Text>
        {detail != null ? <View style={styles.detail}>{detail}</View> : null}
    </View>
}

const styles = StyleSheet.create({
    band: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: componentTokens.sectionBand.gap,
        minHeight: componentTokens.sectionBand.minHeight,
        paddingHorizontal: componentTokens.sectionBand.paddingHorizontal,
        paddingVertical: componentTokens.sectionBand.paddingVertical,
        borderBottomWidth: borderWidth.thin,
        borderBottomColor: colors.borderLight,
    },
    matchup: { paddingHorizontal: componentTokens.sectionBand.matchupPaddingHorizontal, paddingVertical: 0, borderBottomWidth: 0 },
    action: { minHeight: componentTokens.sectionBand.actionHeight, paddingVertical: 0, borderBottomWidth: 0 },
    plain: { ...componentTokens.sectionBand.plain, minHeight: 0, paddingHorizontal: 0, paddingVertical: 0, borderBottomWidth: 0, backgroundColor: 'transparent' },
    label: { ...componentTokens.sectionBand.label, flex: 1, minWidth: 0 },
    detail: { flexDirection: 'row', alignItems: 'center', gap: componentTokens.segmentedControl.gap, flexShrink: 0 },
})

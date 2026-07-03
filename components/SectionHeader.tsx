import { View, Text, StyleSheet } from 'react-native'
import { colors, fontSize, fontWeight, spacing } from '@/constants/tokens'

type Props = { label: string; level?: number; decorative?: boolean }

/** Inline section divider for FlashList / ScrollView lists */
export function SectionHeader({ label, level = 2, decorative = false }: Props) {
    return (
        <View
            style={styles.container}
            role={decorative ? 'presentation' : 'heading'}
            aria-hidden={decorative ? true : undefined}
            aria-level={decorative ? undefined : level}
            accessibilityRole={decorative ? undefined : 'header'}
            accessibilityElementsHidden={decorative}
            accessibilityLabel={decorative ? undefined : label}
            importantForAccessibility={decorative ? 'no-hide-descendants' : undefined}
        >
            <Text style={styles.text}>{label}</Text>
        </View>
    )
}

const styles = StyleSheet.create({
    container: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
        backgroundColor: colors.bgSubtle,
    },
    text: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
        letterSpacing: 0,
        textTransform: 'uppercase',
    },
})

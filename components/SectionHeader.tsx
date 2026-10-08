import { View, Text, StyleSheet } from 'react-native'
import { colors, spacing, textStyles } from '@/constants/tokens'

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
        paddingVertical: spacing.sm,
        backgroundColor: colors.bgSubtle,
    },
    text: { ...textStyles.sectionLabel },
})

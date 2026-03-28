import { View, Text, StyleSheet } from 'react-native'
import { colors, fontSize, fontWeight, spacing } from '@/constants/tokens'

type Props = { label: string }

/** Inline section divider for FlashList / ScrollView lists */
export function SectionHeader({ label }: Props) {
    return (
        <View style={styles.container}>
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
        letterSpacing: 0.5,
        textTransform: 'uppercase',
    },
})

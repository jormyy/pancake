import { View, Text, StyleSheet } from 'react-native'
import { Button } from '@/components/ui/Button'
import { colors, fontSize, fontWeight, spacing } from '@/constants/tokens'

export function DraftNotFoundState({ onBack }: { onBack: () => void }) {
    return (
        <View style={styles.container}>
            <Text accessibilityRole="header" style={styles.title}>Draft not found</Text>
            <Text style={styles.description}>This draft is no longer available.</Text>
            <Button title="Back to League" onPress={onBack} />
        </View>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing['4xl'], gap: spacing.lg },
    title: { fontSize: fontSize['2xl'], fontWeight: fontWeight.extrabold, color: colors.textPrimary, textAlign: 'center' },
    description: { fontSize: fontSize.md, color: colors.textMuted, textAlign: 'center' },
})

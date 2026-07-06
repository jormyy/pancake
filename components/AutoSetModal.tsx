import { Modal, View, Text, Pressable, StyleSheet, Platform } from 'react-native'
import { colors, controlSize, fontSize, fontWeight, radii, scrim, spacing } from '@/constants/tokens'

export function AutoSetModal({
    visible,
    onClose,
    onToday,
    onWholeWeek,
    onRestOfSeason,
    seasonOptimizerEnabled,
    onEnableSeasonOptimizer,
    onDisableSeasonOptimizer,
}: {
    visible: boolean
    onClose: () => void
    onToday: () => void
    onWholeWeek: () => void
    onRestOfSeason: () => void
    seasonOptimizerEnabled: boolean
    onEnableSeasonOptimizer: () => void
    onDisableSeasonOptimizer: () => void
}) {
    return (
        <Modal
            visible={visible}
            animationType="fade"
            transparent
            onRequestClose={onClose}
        >
            <View style={styles.overlay}>
                <View style={styles.content}>
                    <Text style={styles.title}>Auto-Set Lineup</Text>
                    <Text style={styles.text}>Choose how to set your lineup</Text>
                    <View style={styles.buttons}>
                        <Pressable
                            style={styles.button}
                            onPress={onToday}
                            accessibilityRole="button"
                            accessibilityLabel="Auto-set today"
                        >
                            <Text style={styles.buttonText}>Today</Text>
                        </Pressable>
                        <Pressable
                            style={styles.button}
                            onPress={onWholeWeek}
                            accessibilityRole="button"
                            accessibilityLabel="Auto-set whole week"
                        >
                            <Text style={styles.buttonText}>Whole Week</Text>
                        </Pressable>
                    </View>
                    <Pressable
                        style={styles.seasonButton}
                        onPress={onRestOfSeason}
                        accessibilityRole="button"
                        accessibilityLabel="Auto-set rest of season"
                    >
                        <Text style={styles.buttonText}>Rest of Season</Text>
                    </Pressable>
                    <Pressable
                        style={[styles.seasonButton, seasonOptimizerEnabled && styles.secondaryButton]}
                        onPress={seasonOptimizerEnabled ? onDisableSeasonOptimizer : onEnableSeasonOptimizer}
                        accessibilityRole="button"
                        accessibilityLabel={seasonOptimizerEnabled ? 'Disable season optimizer' : 'Enable season optimizer'}
                    >
                        <Text style={[styles.buttonText, seasonOptimizerEnabled && styles.secondaryButtonText]}>
                            {seasonOptimizerEnabled ? 'Disable Season Optimizer' : 'Enable Season Optimizer'}
                        </Text>
                    </Pressable>
                    <Pressable
                        style={styles.cancel}
                        onPress={onClose}
                        accessibilityRole="button"
                        accessibilityLabel="Cancel auto-set"
                    >
                        <Text style={styles.cancelText}>Cancel</Text>
                    </Pressable>
                </View>
            </View>
        </Modal>
    )
}

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: scrim,
        justifyContent: 'center',
        alignItems: 'center',
        padding: spacing['2xl'],
        paddingBottom: Platform.OS === 'web' ? spacing['6xl'] + spacing['4xl'] : spacing['2xl'],
    },
    content: { backgroundColor: colors.bgScreen, borderRadius: radii['2xl'], padding: spacing['2xl'], width: '100%', gap: spacing.xl },
    title: { fontSize: fontSize['2lg'], fontWeight: fontWeight.extrabold, color: colors.textPrimary, textAlign: 'center' },
    text: { fontSize: fontSize.md, color: colors.textMuted, textAlign: 'center' },
    buttons: { flexDirection: 'row', gap: spacing.lg },
    button: { flex: 1, height: controlSize.button.md.height, backgroundColor: colors.primary, borderRadius: radii.lg, justifyContent: 'center', alignItems: 'center' },
    seasonButton: { height: controlSize.button.md.height, backgroundColor: colors.primary, borderRadius: radii.lg, justifyContent: 'center', alignItems: 'center' },
    secondaryButton: { backgroundColor: colors.bgSubtle, borderWidth: 1, borderColor: colors.border },
    buttonText: { fontSize: fontSize.md + 1, fontWeight: fontWeight.bold, color: colors.textWhite },
    secondaryButtonText: { color: colors.textSecondary },
    cancel: { minHeight: controlSize.minTouch, alignItems: 'center', justifyContent: 'center' },
    cancelText: { fontSize: fontSize.md + 1, fontWeight: fontWeight.semibold, color: colors.textMuted },
})

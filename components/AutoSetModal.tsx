import { Modal, View, Text, Pressable, StyleSheet } from 'react-native'
import { colors, scrim } from '@/constants/tokens'

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
    overlay: { flex: 1, backgroundColor: scrim, justifyContent: 'center', alignItems: 'center', padding: 20 },
    content: { backgroundColor: colors.bgScreen, borderRadius: 16, padding: 20, width: '100%', gap: 16 },
    title: { fontSize: 19, fontWeight: '800', color: colors.textPrimary, textAlign: 'center' },
    text: { fontSize: 14, color: colors.textMuted, textAlign: 'center' },
    buttons: { flexDirection: 'row', gap: 12 },
    button: { flex: 1, height: 48, backgroundColor: colors.primary, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
    seasonButton: { height: 48, backgroundColor: colors.primary, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
    secondaryButton: { backgroundColor: colors.bgSubtle, borderWidth: 1, borderColor: colors.border },
    buttonText: { fontSize: 15, fontWeight: '700', color: colors.textWhite },
    secondaryButtonText: { color: colors.textSecondary },
    cancel: { paddingVertical: 8, alignItems: 'center' },
    cancelText: { fontSize: 15, fontWeight: '600', color: colors.textMuted },
})

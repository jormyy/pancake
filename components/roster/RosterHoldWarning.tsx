import { StyleSheet, Text, View } from 'react-native'
import { Button } from '@/components/ui/Button'
import { radii, spacing, textStyles, uiColors } from '@/constants/tokens'
import type { RosterHoldConflict } from '@/lib/waivers'

export function RosterHoldWarning({
    conflicts,
    onPickDrop,
    onUndoAcceptance,
    undoingTradeId = null,
    notice = null,
    testID = 'roster-hold-warning',
}: {
    conflicts: RosterHoldConflict[]
    onPickDrop?: () => void
    onUndoAcceptance?: (conflict: RosterHoldConflict) => void
    undoingTradeId?: string | null
    notice?: string | null
    testID?: string
}) {
    if (conflicts.length === 0 && !notice) return null
    return (
        <View style={styles.stack}>
            {notice ? (
                <View style={styles.noticeCard} accessibilityLiveRegion="polite" role="status" testID={`${testID}-notice`}>
                    <Text style={styles.noticeText}>{notice}</Text>
                </View>
            ) : null}
            {conflicts.length > 0 ? (
                <View style={styles.card} accessibilityLiveRegion="polite" role="status" testID={testID}>
                    {conflicts.map((conflict) => (
                        <View key={conflict.tradeId} style={styles.conflict}>
                            <Text style={styles.message}>{conflict.message}</Text>
                            <View style={styles.actions}>
                                {onPickDrop ? (
                                    <Button title="Pick a drop" size="sm" variant="secondary" onPress={onPickDrop}
                                        accessibilityLabel="Pick a drop for this pickup" />
                                ) : null}
                                {conflict.canWithdraw && onUndoAcceptance ? (
                                    <Button title="Undo acceptance" size="sm" variant="secondary"
                                        onPress={() => onUndoAcceptance(conflict)}
                                        loading={undoingTradeId === conflict.tradeId}
                                        disabled={undoingTradeId !== null}
                                        accessibilityLabel={`Undo acceptance of the trade with ${conflict.partnerTeamNames.join(', ')}`} />
                                ) : null}
                            </View>
                        </View>
                    ))}
                </View>
            ) : null}
        </View>
    )
}

const styles = StyleSheet.create({
    stack: { gap: spacing.md },
    noticeCard: {
        padding: spacing.lg,
        backgroundColor: uiColors.successSurface,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: uiColors.successBorder,
    },
    noticeText: { ...textStyles.body, color: uiColors.successText },
    card: {
        padding: spacing.lg,
        backgroundColor: uiColors.warningSurface,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: uiColors.warningBorder,
        gap: spacing.md,
    },
    conflict: { gap: spacing.sm },
    message: { ...textStyles.body, color: uiColors.warningText },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
})

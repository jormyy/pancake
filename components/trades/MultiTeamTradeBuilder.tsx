import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { TradeAssetColumn } from '@/components/trades/TradeAssetColumn'
import { colors, fontSize, fontWeight, radii, spacing, uiColors } from '@/constants/tokens'
import type { RosterPlayer } from '@/lib/roster'
import type { TradePickItem } from '@/lib/trades'

type MultiTeamTradeBuilderProps = {
    participantIds: string[]
    myMemberId: string
    faabEnabled: boolean
    notes: string
    expirationDays: string
    rosterError: string | null
    participantRosters: Record<string, RosterPlayer[]>
    participantPicks: Record<string, TradePickItem[]>
    participantPlayerIds: Record<string, Set<string>>
    participantPickIds: Record<string, Set<string>>
    participantFaabInputs: Record<string, string>
    avgMap: Map<string, number>
    avgStatsMap: Map<string, { avg_minutes_played: number | null }>
    participantName: (memberId: string) => string
    onRetry: () => void
    onTogglePlayer: (memberId: string, playerId: string) => void
    onTogglePick: (memberId: string, pickId: string) => void
    onFaabChange: (memberId: string, value: string) => void
    onNotesChange: (value: string) => void
    onExpirationDaysChange: (value: string) => void
}

export function MultiTeamTradeBuilder({
    participantIds,
    myMemberId,
    faabEnabled,
    notes,
    expirationDays,
    rosterError,
    participantRosters,
    participantPicks,
    participantPlayerIds,
    participantPickIds,
    participantFaabInputs,
    avgMap,
    avgStatsMap,
    participantName,
    onRetry,
    onTogglePlayer,
    onTogglePick,
    onFaabChange,
    onNotesChange,
    onExpirationDaysChange,
}: MultiTeamTradeBuilderProps) {
    if (rosterError) {
        return (
            <Pressable
                style={styles.rosterErrorRow}
                onPress={onRetry}
                accessibilityRole="button"
                accessibilityLabel="Failed to load rosters. Tap to retry."
            >
                <Text style={styles.rosterErrorText}>Failed to load rosters. Tap to retry.</Text>
            </Pressable>
        )
    }

    return (
        <>
            <Text style={styles.sectionLabel}>MULTI-TEAM BUILDER</Text>
            <View style={styles.multiTeamStack}>
                {participantIds.map((memberId, index) => {
                    const toMemberId = participantIds[(index + 1) % participantIds.length]
                    const roster = participantRosters[memberId] ?? []
                    const picks = participantPicks[memberId] ?? []
                    return (
                        <View key={memberId} style={styles.multiTeamPanel}>
                            <TradeAssetColumn
                                title={`${memberId === myMemberId ? 'YOU' : participantName(memberId).toUpperCase()} SENDS`}
                                subtitle={`To ${participantName(toMemberId)}`}
                                side="give"
                                twoColumn={false}
                                roster={roster}
                                picks={picks}
                                avgMap={avgMap}
                                avgStatsMap={avgStatsMap}
                                selectedPlayerIds={participantPlayerIds[memberId] ?? new Set()}
                                selectedPickIds={participantPickIds[memberId] ?? new Set()}
                                onTogglePlayer={(playerId) => onTogglePlayer(memberId, playerId)}
                                onTogglePick={(pickId) => onTogglePick(memberId, pickId)}
                                emptyText="No tradeable active players."
                            />
                            {faabEnabled ? (
                                <View style={styles.multiFaabRow}>
                                    <Text style={styles.termLabel}>FAAB to {participantName(toMemberId)}</Text>
                                    <TextInput
                                        style={styles.termInput}
                                        value={participantFaabInputs[memberId] ?? '0'}
                                        onChangeText={(value) => onFaabChange(memberId, value)}
                                        keyboardType="numeric"
                                    />
                                </View>
                            ) : null}
                        </View>
                    )
                })}
            </View>
            <Text style={styles.sectionLabel}>NOTES (optional)</Text>
            <TextInput
                style={styles.notesInput}
                placeholder="Add a message to your trade offer..."
                placeholderTextColor={colors.textPlaceholder}
                value={notes}
                onChangeText={onNotesChange}
                multiline
                numberOfLines={3}
            />
            <Text style={styles.sectionLabel}>TERMS</Text>
            <View style={styles.termsRow}>
                <View style={styles.termField}>
                    <Text style={styles.termLabel}>Expires in days</Text>
                    <TextInput
                        style={styles.termInput}
                        value={expirationDays}
                        onChangeText={(value) => {
                            if (/^\d*$/.test(value)) onExpirationDaysChange(value)
                        }}
                        keyboardType="numeric"
                    />
                </View>
            </View>
        </>
    )
}

const styles = StyleSheet.create({
    sectionLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textPlaceholder,
        letterSpacing: 0,
        paddingHorizontal: spacing.xl,
        paddingTop: spacing['2xl'],
        paddingBottom: spacing.md,
    },
    multiTeamStack: { gap: spacing.lg, marginBottom: spacing.lg },
    multiTeamPanel: {
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgScreen,
    },
    multiFaabRow: {
        marginHorizontal: spacing.xl,
        marginBottom: spacing.lg,
        gap: spacing.xs,
        maxWidth: 220,
    },
    notesInput: {
        marginHorizontal: spacing.xl,
        borderWidth: 1,
        borderColor: uiColors.borderNeutral,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        paddingHorizontal: 14,
        paddingVertical: 10,
        fontSize: fontSize.md,
        color: colors.textPrimary,
        minHeight: 80,
        textAlignVertical: 'top',
    },
    termsRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.md,
        marginHorizontal: spacing.xl,
    },
    termField: {
        flexGrow: 1,
        flexBasis: 150,
        minWidth: 150,
        gap: spacing.xs,
    },
    termLabel: {
        fontSize: 10,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
        letterSpacing: 0,
    },
    termInput: {
        minHeight: 44,
        borderWidth: 1,
        borderColor: uiColors.borderNeutral,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.md,
        fontSize: fontSize.md,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
    },
    rosterErrorRow: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        minHeight: 44,
        alignItems: 'center',
    },
    rosterErrorText: {
        color: colors.dangerDark,
        fontSize: fontSize.md,
        fontWeight: fontWeight.semibold,
        textAlign: 'center',
    },
})

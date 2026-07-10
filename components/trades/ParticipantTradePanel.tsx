import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { TradeAssetColumn } from '@/components/trades/TradeAssetColumn'
import { colors, fontSize, fontWeight, radii, spacing, uiColors } from '@/constants/tokens'
import { canUpdateTradeFaabInput, MAX_TRADE_FAAB_DIGITS, validateTradeFaabInput } from '@/lib/multi-team-trade-state'
import type { TradeParticipantView } from '@/lib/trade-ui-model'

type ParticipantTradePanelProps = {
    participant: TradeParticipantView
    myMemberId: string
    faabEnabled: boolean
    useColumns: boolean
    avgMap: Map<string, number>
    avgStatsMap: Map<string, { avg_minutes_played: number | null }>
    participantName: (memberId: string) => string
    onTogglePlayer: (memberId: string, playerId: string) => void
    onTogglePick: (memberId: string, pickId: string) => void
    onDestinationChange: (memberId: string, toMemberId: string) => void
    onPlayerDestinationChange: (memberId: string, playerId: string, toMemberId: string) => void
    onPickDestinationChange: (memberId: string, pickId: string, toMemberId: string) => void
    onFaabChange: (memberId: string, toMemberId: string, value: string) => void
}

type RouteOptionsProps = {
    destinationIds: string[]
    selectedId: string
    participantName: (memberId: string) => string
    accessibilityLabel: (destinationId: string) => string
    testID?: (destinationId: string) => string
    onChange: (destinationId: string) => void
}

function RouteOptions({
    destinationIds,
    selectedId,
    participantName,
    accessibilityLabel,
    testID,
    onChange,
}: RouteOptionsProps) {
    return (
        <View style={styles.routeOptions}>
            {destinationIds.map((destinationId) => {
                const active = destinationId === selectedId
                return (
                    <Pressable
                        key={destinationId}
                        style={[styles.routeOption, active && styles.routeOptionActive]}
                        onPress={() => onChange(destinationId)}
                        accessibilityRole="button"
                        accessibilityLabel={accessibilityLabel(destinationId)}
                        accessibilityState={{ selected: active }}
                        testID={testID?.(destinationId)}
                        id={testID?.(destinationId)}
                    >
                        <Text style={[styles.routeOptionText, active && styles.routeOptionTextActive]} numberOfLines={1}>
                            {participantName(destinationId)}
                        </Text>
                    </Pressable>
                )
            })}
        </View>
    )
}

export function ParticipantTradePanel({
    participant,
    myMemberId,
    faabEnabled,
    useColumns,
    avgMap,
    avgStatsMap,
    participantName,
    onTogglePlayer,
    onTogglePick,
    onDestinationChange,
    onPlayerDestinationChange,
    onPickDestinationChange,
    onFaabChange,
}: ParticipantTradePanelProps) {
    const selectedPlayers = participant.roster.filter((player) => participant.selectedPlayerIds.has(player.players.id))
    const selectedPicks = participant.picks.filter((pick) => participant.selectedPickIds.has(pick.pickId))
    const destinationName = participant.defaultDestinationId
        ? participantName(participant.defaultDestinationId)
        : 'Choose a destination'

    return (
        <View style={[styles.panel, useColumns ? styles.panelColumn : styles.panelStacked]}>
            {participant.destinationIds.length > 1 ? (
                <View style={styles.routePicker}>
                    <Text style={styles.routePickerLabel}>DEFAULT SEND TO</Text>
                    <RouteOptions
                        destinationIds={participant.destinationIds}
                        selectedId={participant.defaultDestinationId}
                        participantName={participantName}
                        accessibilityLabel={(destinationId) =>
                            `${participantName(participant.memberId)} sends selected assets to ${participantName(destinationId)}`
                        }
                        testID={(destinationId) => `trade-default-route-${participant.memberId}-${destinationId}`}
                        onChange={(destinationId) => onDestinationChange(participant.memberId, destinationId)}
                    />
                </View>
            ) : null}
            <TradeAssetColumn
                title={participant.memberId === myMemberId ? 'YOU SEND' : `${participantName(participant.memberId).toUpperCase()} SENDS`}
                subtitle={`To ${destinationName}`}
                side="give"
                twoColumn={useColumns}
                roster={participant.roster}
                picks={participant.picks}
                avgMap={avgMap}
                avgStatsMap={avgStatsMap}
                selectedPlayerIds={participant.selectedPlayerIds}
                selectedPickIds={participant.selectedPickIds}
                playerDestinationLabel={(playerId) => participantName(participant.playerDestinationIds[playerId])}
                pickDestinationLabel={(pickId) => participantName(participant.pickDestinationIds[pickId])}
                onTogglePlayer={(playerId) => onTogglePlayer(participant.memberId, playerId)}
                onTogglePick={(pickId) => onTogglePick(participant.memberId, pickId)}
                emptyText="No tradeable active players."
                testIdPrefix={`trade-${participant.memberId}`}
            />
            {participant.destinationIds.length > 1 && (selectedPlayers.length > 0 || selectedPicks.length > 0) ? (
                <View style={styles.selectedRoutes}>
                    <Text style={styles.routePickerLabel}>SELECTED ROUTES</Text>
                    {selectedPlayers.map((player) => {
                        const playerId = player.players.id
                        return (
                            <View key={`player:${playerId}`} style={styles.selectedRouteRow}>
                                <Text style={styles.selectedRouteName} numberOfLines={2}>{player.players.display_name}</Text>
                                <RouteOptions
                                    destinationIds={participant.destinationIds}
                                    selectedId={participant.playerDestinationIds[playerId]}
                                    participantName={participantName}
                                    accessibilityLabel={(destinationId) =>
                                        `Route ${player.players.display_name} to ${participantName(destinationId)}`
                                    }
                                    testID={(destinationId) => `trade-player-route-${participant.memberId}-${playerId}-${destinationId}`}
                                    onChange={(destinationId) =>
                                        onPlayerDestinationChange(participant.memberId, playerId, destinationId)
                                    }
                                />
                            </View>
                        )
                    })}
                    {selectedPicks.map((pick) => {
                        const label = `${pick.seasonYear} Round ${pick.round}`
                        return (
                            <View key={`pick:${pick.pickId}`} style={styles.selectedRouteRow}>
                                <Text style={styles.selectedRouteName} numberOfLines={2}>{label}</Text>
                                <RouteOptions
                                    destinationIds={participant.destinationIds}
                                    selectedId={participant.pickDestinationIds[pick.pickId]}
                                    participantName={participantName}
                                    accessibilityLabel={(destinationId) =>
                                        `Route ${label} pick to ${participantName(destinationId)}`
                                    }
                                    testID={(destinationId) => `trade-pick-route-${participant.memberId}-${pick.pickId}-${destinationId}`}
                                    onChange={(destinationId) =>
                                        onPickDestinationChange(participant.memberId, pick.pickId, destinationId)
                                    }
                                />
                            </View>
                        )
                    })}
                </View>
            ) : null}
            {faabEnabled ? (
                <View style={styles.faabRow}>
                    <Text style={styles.routePickerLabel}>FAAB ROUTES</Text>
                    {participant.destinationIds.map((destinationId) => {
                        const value = participant.faabInputs[destinationId] ?? '0'
                        const error = validateTradeFaabInput(value).error
                        return (
                            <View key={destinationId} style={styles.faabDestinationRow}>
                                <Text style={styles.termLabel}>To {participantName(destinationId)}</Text>
                                <TextInput
                                    style={[styles.termInput, error && styles.termInputInvalid]}
                                    value={value}
                                    onChangeText={(nextValue) => {
                                        if (canUpdateTradeFaabInput(value, nextValue)) {
                                            onFaabChange(participant.memberId, destinationId, nextValue)
                                        }
                                    }}
                                    maxLength={Math.max(MAX_TRADE_FAAB_DIGITS, value.length)}
                                    keyboardType="numeric"
                                    accessibilityLabel={error
                                        ? `FAAB sent by ${participantName(participant.memberId)} to ${participantName(destinationId)}. ${error}`
                                        : `FAAB sent by ${participantName(participant.memberId)} to ${participantName(destinationId)}`
                                    }
                                    aria-invalid={Boolean(error)}
                                    testID={`trade-faab-${participant.memberId}-${destinationId}`}
                                    id={`trade-faab-${participant.memberId}-${destinationId}`}
                                />
                                {error ? (
                                    <Text
                                        style={styles.faabError}
                                        accessibilityRole="alert"
                                        accessibilityLiveRegion="polite"
                                        testID={`trade-faab-error-${participant.memberId}-${destinationId}`}
                                    >
                                        {error}
                                    </Text>
                                ) : null}
                            </View>
                        )
                    })}
                </View>
            ) : null}
        </View>
    )
}

const styles = StyleSheet.create({
    panel: {
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: uiColors.surfaceAlt,
        overflow: 'hidden',
    },
    panelColumn: { flexGrow: 1, flexShrink: 0, flexBasis: 260, minWidth: 260, maxWidth: 320 },
    panelStacked: { width: '100%' },
    routePicker: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, gap: spacing.xs },
    routePickerLabel: { fontSize: 10, fontWeight: fontWeight.bold, color: colors.textMuted, letterSpacing: 0 },
    routeOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
    routeOption: {
        minHeight: 44,
        maxWidth: 180,
        borderWidth: 1,
        borderColor: uiColors.borderNeutral,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.md,
        alignItems: 'center',
        justifyContent: 'center',
    },
    routeOptionActive: { borderColor: colors.primary, backgroundColor: colors.primary },
    routeOptionText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    routeOptionTextActive: { color: colors.textWhite },
    selectedRoutes: { paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: spacing.sm, gap: spacing.sm },
    selectedRouteRow: { gap: spacing.xs },
    selectedRouteName: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    faabRow: { marginHorizontal: spacing.xl, marginBottom: spacing.lg, gap: spacing.sm },
    faabDestinationRow: { gap: spacing.xs, maxWidth: 220 },
    termLabel: { fontSize: 10, fontWeight: fontWeight.bold, color: colors.textMuted, letterSpacing: 0 },
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
    termInputInvalid: { borderColor: colors.danger },
    faabError: { color: colors.dangerDark, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
})

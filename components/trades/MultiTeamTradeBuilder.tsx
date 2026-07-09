import { Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native'
import { TradeAssetColumn } from '@/components/trades/TradeAssetColumn'
import { breakpoints, colors, fontSize, fontWeight, radii, spacing, uiColors } from '@/constants/tokens'
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
    participantDestinationIds: Record<string, string>
    participantPlayerDestinationIds: Record<string, Record<string, string>>
    participantPickDestinationIds: Record<string, Record<string, string>>
    participantFaabInputs: Record<string, string>
    avgMap: Map<string, number>
    avgStatsMap: Map<string, { avg_minutes_played: number | null }>
    participantName: (memberId: string) => string
    onRetry: () => void
    onTogglePlayer: (memberId: string, playerId: string) => void
    onTogglePick: (memberId: string, pickId: string) => void
    onDestinationChange: (memberId: string, toMemberId: string) => void
    onPlayerDestinationChange: (memberId: string, playerId: string, toMemberId: string) => void
    onPickDestinationChange: (memberId: string, pickId: string, toMemberId: string) => void
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
    participantDestinationIds,
    participantPlayerDestinationIds,
    participantPickDestinationIds,
    participantFaabInputs,
    avgMap,
    avgStatsMap,
    participantName,
    onRetry,
    onTogglePlayer,
    onTogglePick,
    onDestinationChange,
    onPlayerDestinationChange,
    onPickDestinationChange,
    onFaabChange,
    onNotesChange,
    onExpirationDaysChange,
}: MultiTeamTradeBuilderProps) {
    const { width } = useWindowDimensions()
    const useColumns = width >= breakpoints.roster && participantIds.length > 1

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

    const panels = participantIds.map((memberId) => {
        const destinationOptions = participantIds.filter((id) => id !== memberId)
        const toMemberId = participantDestinationIds[memberId] && destinationOptions.includes(participantDestinationIds[memberId])
            ? participantDestinationIds[memberId]
            : destinationOptions[0]
        const roster = participantRosters[memberId] ?? []
        const picks = participantPicks[memberId] ?? []
        const selectedPlayerIds = participantPlayerIds[memberId] ?? new Set<string>()
        const selectedPickIds = participantPickIds[memberId] ?? new Set<string>()
        const playerDestinations = participantPlayerDestinationIds[memberId] ?? {}
        const pickDestinations = participantPickDestinationIds[memberId] ?? {}
        const destinationForPlayer = (playerId: string) => {
            const destinationId = playerDestinations[playerId]
            if (destinationId && destinationOptions.includes(destinationId)) return destinationId
            return toMemberId
        }
        const destinationForPick = (pickId: string) => {
            const destinationId = pickDestinations[pickId]
            if (destinationId && destinationOptions.includes(destinationId)) return destinationId
            return toMemberId
        }
        const selectedPlayers = roster.filter((player) => selectedPlayerIds.has(player.players.id))
        const selectedPicks = picks.filter((pick) => selectedPickIds.has(pick.pickId))

        return (
            <View
                key={memberId}
                style={[
                    styles.multiTeamPanel,
                    useColumns ? styles.multiTeamPanelColumn : styles.multiTeamPanelStacked,
                ]}
            >
                <View style={styles.routePicker}>
                    <Text style={styles.routePickerLabel}>DEFAULT SEND TO</Text>
                    <View style={styles.routeOptions}>
                        {destinationOptions.map((destinationId) => {
                            const active = destinationId === toMemberId
                            return (
                                <Pressable
                                    key={destinationId}
                                    style={[styles.routeOption, active && styles.routeOptionActive]}
                                    onPress={() => onDestinationChange(memberId, destinationId)}
                                    accessibilityRole="button"
                                    accessibilityLabel={`${participantName(memberId)} sends selected assets to ${participantName(destinationId)}`}
                                >
                                    <Text
                                        style={[
                                            styles.routeOptionText,
                                            active && styles.routeOptionTextActive,
                                        ]}
                                        numberOfLines={1}
                                    >
                                        {participantName(destinationId)}
                                    </Text>
                                </Pressable>
                            )
                        })}
                    </View>
                </View>
                <TradeAssetColumn
                    title={`${memberId === myMemberId ? 'YOU' : participantName(memberId).toUpperCase()} SENDS`}
                    subtitle={toMemberId ? `To ${participantName(toMemberId)}` : 'Choose a destination'}
                    side="give"
                    twoColumn={useColumns}
                    roster={roster}
                    picks={picks}
                    avgMap={avgMap}
                    avgStatsMap={avgStatsMap}
                    selectedPlayerIds={selectedPlayerIds}
                    selectedPickIds={selectedPickIds}
                    playerDestinationLabel={(playerId) => participantName(destinationForPlayer(playerId))}
                    pickDestinationLabel={(pickId) => participantName(destinationForPick(pickId))}
                    onTogglePlayer={(playerId) => onTogglePlayer(memberId, playerId)}
                    onTogglePick={(pickId) => onTogglePick(memberId, pickId)}
                    emptyText="No tradeable active players."
                />
                {selectedPlayers.length > 0 || selectedPicks.length > 0 ? (
                    <View style={styles.selectedRoutes}>
                        <Text style={styles.routePickerLabel}>SELECTED ROUTES</Text>
                        {selectedPlayers.map((player) => {
                            const playerId = player.players.id
                            const selectedDestinationId = destinationForPlayer(playerId)
                            return (
                                <View key={`player:${playerId}`} style={styles.selectedRouteRow}>
                                    <Text style={styles.selectedRouteName} numberOfLines={2}>
                                        {player.players.display_name}
                                    </Text>
                                    <View style={styles.routeOptions}>
                                        {destinationOptions.map((destinationId) => {
                                            const active = destinationId === selectedDestinationId
                                            return (
                                                <Pressable
                                                    key={destinationId}
                                                    style={[styles.routeOption, active && styles.routeOptionActive]}
                                                    onPress={() => onPlayerDestinationChange(memberId, playerId, destinationId)}
                                                    accessibilityRole="button"
                                                    accessibilityLabel={`Route ${player.players.display_name} to ${participantName(destinationId)}`}
                                                >
                                                    <Text
                                                        style={[
                                                            styles.routeOptionText,
                                                            active && styles.routeOptionTextActive,
                                                        ]}
                                                        numberOfLines={1}
                                                    >
                                                        {participantName(destinationId)}
                                                    </Text>
                                                </Pressable>
                                            )
                                        })}
                                    </View>
                                </View>
                            )
                        })}
                        {selectedPicks.map((pick) => {
                            const selectedDestinationId = destinationForPick(pick.pickId)
                            const label = `${pick.seasonYear} Round ${pick.round}`
                            return (
                                <View key={`pick:${pick.pickId}`} style={styles.selectedRouteRow}>
                                    <Text style={styles.selectedRouteName} numberOfLines={2}>
                                        {label}
                                    </Text>
                                    <View style={styles.routeOptions}>
                                        {destinationOptions.map((destinationId) => {
                                            const active = destinationId === selectedDestinationId
                                            return (
                                                <Pressable
                                                    key={destinationId}
                                                    style={[styles.routeOption, active && styles.routeOptionActive]}
                                                    onPress={() => onPickDestinationChange(memberId, pick.pickId, destinationId)}
                                                    accessibilityRole="button"
                                                    accessibilityLabel={`Route ${label} pick to ${participantName(destinationId)}`}
                                                >
                                                    <Text
                                                        style={[
                                                            styles.routeOptionText,
                                                            active && styles.routeOptionTextActive,
                                                        ]}
                                                        numberOfLines={1}
                                                    >
                                                        {participantName(destinationId)}
                                                    </Text>
                                                </Pressable>
                                            )
                                        })}
                                    </View>
                                </View>
                            )
                        })}
                    </View>
                ) : null}
                {faabEnabled ? (
                    <View style={styles.multiFaabRow}>
                        <Text style={styles.termLabel}>
                            FAAB to {toMemberId ? participantName(toMemberId) : 'destination'}
                        </Text>
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
    })

    return (
        <>
            <Text style={styles.sectionLabel}>MULTI-TEAM BUILDER</Text>
            {useColumns ? (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.multiTeamScroller}
                    contentContainerStyle={styles.multiTeamColumns}
                >
                    {panels}
                </ScrollView>
            ) : (
                <View style={styles.multiTeamStack}>{panels}</View>
            )}
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
    multiTeamScroller: { marginBottom: spacing.lg },
    multiTeamColumns: {
        flexDirection: 'row',
        gap: spacing.md,
        paddingHorizontal: spacing.xl,
        paddingBottom: spacing.sm,
    },
    multiTeamPanel: {
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgScreen,
        overflow: 'hidden',
    },
    multiTeamPanelColumn: {
        flexGrow: 1,
        flexShrink: 0,
        flexBasis: 280,
        minWidth: 280,
        maxWidth: 340,
    },
    multiTeamPanelStacked: { width: '100%' },
    routePicker: {
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.lg,
        gap: spacing.xs,
    },
    routePickerLabel: {
        fontSize: 10,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
        letterSpacing: 0,
    },
    routeOptions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.xs,
    },
    routeOption: {
        minHeight: 36,
        maxWidth: 180,
        borderWidth: 1,
        borderColor: uiColors.borderNeutral,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.md,
        alignItems: 'center',
        justifyContent: 'center',
    },
    routeOptionActive: {
        borderColor: colors.primary,
        backgroundColor: colors.primary,
    },
    routeOptionText: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.semibold,
        color: colors.textSecondary,
    },
    routeOptionTextActive: { color: colors.textWhite },
    selectedRoutes: {
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.md,
        paddingBottom: spacing.sm,
        gap: spacing.sm,
    },
    selectedRouteRow: { gap: spacing.xs },
    selectedRouteName: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.semibold,
        color: colors.textPrimary,
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

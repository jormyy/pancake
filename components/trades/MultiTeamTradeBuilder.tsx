import { useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native'
import { MultiTeamTradeOverview, type TradeFlowItem } from '@/components/trades/MultiTeamTradeOverview'
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
    const [activeParticipantId, setActiveParticipantId] = useState(participantIds[0] ?? '')

    useEffect(() => {
        if (!participantIds.includes(activeParticipantId)) {
            setActiveParticipantId(participantIds[0] ?? '')
        }
    }, [activeParticipantId, participantIds])

    const overviewItems = useMemo(() => participantIds.flatMap<TradeFlowItem>((memberId) => {
        const destinationOptions = participantIds.filter((id) => id !== memberId)
        const defaultDestinationId = participantDestinationIds[memberId] && destinationOptions.includes(participantDestinationIds[memberId])
            ? participantDestinationIds[memberId]
            : destinationOptions[0]
        const playerDestinations = participantPlayerDestinationIds[memberId] ?? {}
        const pickDestinations = participantPickDestinationIds[memberId] ?? {}
        const selectedPlayerIds = participantPlayerIds[memberId] ?? new Set<string>()
        const selectedPickIds = participantPickIds[memberId] ?? new Set<string>()
        const players = (participantRosters[memberId] ?? []).flatMap<TradeFlowItem>((player) => {
            const playerId = player.players.id
            if (!selectedPlayerIds.has(playerId) || !defaultDestinationId) return []
            return [{
                key: `player:${memberId}:${playerId}`,
                fromMemberId: memberId,
                toMemberId: playerDestinations[playerId] ?? defaultDestinationId,
                label: player.players.display_name,
                detail: player.players.position,
            }]
        })
        const picks = (participantPicks[memberId] ?? []).flatMap<TradeFlowItem>((pick) => {
            if (!selectedPickIds.has(pick.pickId) || !defaultDestinationId) return []
            return [{
                key: `pick:${memberId}:${pick.pickId}`,
                fromMemberId: memberId,
                toMemberId: pickDestinations[pick.pickId] ?? defaultDestinationId,
                label: `${pick.seasonYear} Round ${pick.round}`,
                detail: `${pick.originalTeamName} pick`,
            }]
        })
        const faabAmount = parseInt(participantFaabInputs[memberId] ?? '0', 10) || 0
        const faab = faabEnabled && faabAmount > 0 && defaultDestinationId
            ? [{
                key: `faab:${memberId}`,
                fromMemberId: memberId,
                toMemberId: defaultDestinationId,
                label: `$${faabAmount} FAAB`,
            }]
            : []
        return [...players, ...picks, ...faab]
    }), [
        faabEnabled,
        participantDestinationIds,
        participantFaabInputs,
        participantIds,
        participantPickDestinationIds,
        participantPickIds,
        participantPicks,
        participantPlayerDestinationIds,
        participantPlayerIds,
        participantRosters,
    ])

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
                    title={memberId === myMemberId ? 'YOU SEND' : `${participantName(memberId).toUpperCase()} SENDS`}
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
            <MultiTeamTradeOverview
                participants={participantIds.map((memberId) => ({
                    memberId,
                    label: memberId === myMemberId ? 'You' : participantName(memberId),
                }))}
                items={overviewItems}
            />
            <Text style={styles.sectionLabel}>BUILD THE DEAL</Text>
            {!useColumns ? (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.senderTabs}
                    accessibilityRole="tablist"
                >
                    {participantIds.map((memberId) => {
                        const active = memberId === activeParticipantId
                        return (
                            <Pressable
                                key={memberId}
                                style={[styles.senderTab, active && styles.senderTabActive]}
                                onPress={() => setActiveParticipantId(memberId)}
                                accessibilityRole="tab"
                                accessibilityState={{ selected: active }}
                                accessibilityLabel={`Edit assets sent by ${memberId === myMemberId ? 'you' : participantName(memberId)}`}
                            >
                                <Text style={[styles.senderTabText, active && styles.senderTabTextActive]} numberOfLines={1}>
                                    {memberId === myMemberId ? 'You send' : `${participantName(memberId)} sends`}
                                </Text>
                            </Pressable>
                        )
                    })}
                </ScrollView>
            ) : null}
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
                <View style={styles.multiTeamStack}>
                    {panels.find((panel) => panel.key === activeParticipantId) ?? panels[0]}
                </View>
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
    senderTabs: {
        gap: spacing.sm,
        paddingHorizontal: spacing.xl,
        paddingBottom: spacing.md,
    },
    senderTab: {
        minWidth: 112,
        maxWidth: 200,
        minHeight: 40,
        paddingHorizontal: spacing.md,
        borderBottomWidth: 2,
        borderBottomColor: colors.borderLight,
        alignItems: 'center',
        justifyContent: 'center',
    },
    senderTabActive: { borderBottomColor: colors.primary },
    senderTabText: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.semibold,
        color: colors.textMuted,
    },
    senderTabTextActive: { color: colors.textPrimary },
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

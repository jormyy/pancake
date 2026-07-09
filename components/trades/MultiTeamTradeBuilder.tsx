import { useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native'
import { MultiTeamTradeOverview, type TradeFlowItem } from '@/components/trades/MultiTeamTradeOverview'
import { ParticipantTradePanel } from '@/components/trades/ParticipantTradePanel'
import { breakpoints, colors, fontSize, fontWeight, radii, spacing, uiColors } from '@/constants/tokens'
import type { TradeParticipantView } from '@/hooks/use-multi-team-trade-composer'

type MultiTeamTradeBuilderProps = {
    participants: TradeParticipantView[]
    myMemberId: string
    faabEnabled: boolean
    notes: string
    expirationDays: string
    rosterError: string | null
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
    participants,
    myMemberId,
    faabEnabled,
    notes,
    expirationDays,
    rosterError,
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
    const useColumns = width >= breakpoints.roster
    const [activeParticipantId, setActiveParticipantId] = useState(participants[0]?.memberId ?? '')

    useEffect(() => {
        if (!participants.some((participant) => participant.memberId === activeParticipantId)) {
            setActiveParticipantId(participants[0]?.memberId ?? '')
        }
    }, [activeParticipantId, participants])

    const overviewItems = useMemo<TradeFlowItem[]>(() => participants.flatMap((participant) => {
        const players = participant.roster
            .filter((player) => participant.selectedPlayerIds.has(player.players.id))
            .map((player) => ({
                key: `player:${participant.memberId}:${player.players.id}`,
                fromMemberId: participant.memberId,
                toMemberId: participant.playerDestinationIds[player.players.id],
                label: player.players.display_name,
            }))
        const picks = participant.picks
            .filter((pick) => participant.selectedPickIds.has(pick.pickId))
            .map((pick) => ({
                key: `pick:${participant.memberId}:${pick.pickId}`,
                fromMemberId: participant.memberId,
                toMemberId: participant.pickDestinationIds[pick.pickId],
                label: `${pick.seasonYear} Round ${pick.round}`,
            }))
        const faabAmount = parseInt(participant.faabInput || '0', 10) || 0
        const faab = faabEnabled && faabAmount > 0 && participant.defaultDestinationId
            ? [{
                key: `faab:${participant.memberId}`,
                fromMemberId: participant.memberId,
                toMemberId: participant.defaultDestinationId,
                label: `$${faabAmount} FAAB`,
            }]
            : []
        return [...players, ...picks, ...faab]
    }), [faabEnabled, participants])

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

    const panels = participants.map((participant) => (
        <ParticipantTradePanel
            key={participant.memberId}
            participant={participant}
            myMemberId={myMemberId}
            faabEnabled={faabEnabled}
            useColumns={useColumns}
            avgMap={avgMap}
            avgStatsMap={avgStatsMap}
            participantName={participantName}
            onTogglePlayer={onTogglePlayer}
            onTogglePick={onTogglePick}
            onDestinationChange={onDestinationChange}
            onPlayerDestinationChange={onPlayerDestinationChange}
            onPickDestinationChange={onPickDestinationChange}
            onFaabChange={onFaabChange}
        />
    ))

    return (
        <>
            <MultiTeamTradeOverview
                participants={participants.map((participant) => ({
                    memberId: participant.memberId,
                    label: participant.memberId === myMemberId ? 'You' : participantName(participant.memberId),
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
                    {participants.map((participant) => {
                        const active = participant.memberId === activeParticipantId
                        return (
                            <Pressable
                                key={participant.memberId}
                                style={[styles.senderTab, active && styles.senderTabActive]}
                                onPress={() => setActiveParticipantId(participant.memberId)}
                                accessibilityRole="tab"
                                accessibilityState={{ selected: active }}
                                accessibilityLabel={`Edit assets sent by ${participant.memberId === myMemberId ? 'you' : participantName(participant.memberId)}`}
                                testID={`trade-sender-${participant.memberId}`}
                                id={`trade-sender-${participant.memberId}`}
                            >
                                <Text style={[styles.senderTabText, active && styles.senderTabTextActive]} numberOfLines={1}>
                                    {participant.memberId === myMemberId ? 'You send' : `${participantName(participant.memberId)} sends`}
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
                    style={styles.scroller}
                    contentContainerStyle={styles.columns}
                >
                    {panels}
                </ScrollView>
            ) : (
                <View style={styles.stack}>
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
    stack: { gap: spacing.lg, marginBottom: spacing.lg },
    scroller: { marginBottom: spacing.lg },
    columns: { flexDirection: 'row', gap: spacing.md, paddingHorizontal: spacing.xl, paddingBottom: spacing.sm },
    senderTabs: { gap: spacing.sm, paddingHorizontal: spacing.xl, paddingBottom: spacing.md },
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
    senderTabText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textMuted },
    senderTabTextActive: { color: colors.textPrimary },
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
    termsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginHorizontal: spacing.xl },
    termField: { flexGrow: 1, flexBasis: 150, minWidth: 150, gap: spacing.xs },
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
    rosterErrorRow: { paddingHorizontal: spacing.xl, paddingVertical: spacing.lg, minHeight: 44, alignItems: 'center' },
    rosterErrorText: { color: colors.dangerDark, fontSize: fontSize.md, fontWeight: fontWeight.semibold, textAlign: 'center' },
})

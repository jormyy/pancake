import { useLeagueTimezone } from '@/hooks/use-league-timezone'
import { formatLeagueDateTime } from '@/lib/timezone'
import { playerSeasonContextText } from '@/lib/player-context'
import { pickLabel } from '@/lib/picks'
import type { TradePickContext } from '@/lib/trade-pick-label'
import { DeferredContent } from '@/components/ui/DeferredContent'
import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native'
import { MAX_TRADE_EXPIRATION_DAYS, MAX_TRADE_NOTES_BYTES, utf8ByteLength } from '@pancake/core'
import { MultiTeamTradeOverview, type TradeFlowItem } from '@/components/trades/MultiTeamTradeOverview'
import { Card } from '@/components/ui/Card'
import { SectionBand } from '@/components/ui/SectionBand'
import { ParticipantTradePanel } from '@/components/trades/ParticipantTradePanel'
import { breakpoints, colors, componentTokens, controlSize, fontWeight, layout, radii, spacing, textStyles, uiColors, typeScale } from '@/constants/tokens'
import type { TradeParticipantView } from '@/lib/trade-ui-model'
import { buildTradeComposerPayload } from '@/lib/trade-composer'
import type { LeagueStatus } from '@/types/database'
import type { MultiTeamTradeItemPayload } from '@/lib/trades'

type MultiTeamTradeBuilderProps = {
    participants: TradeParticipantView[]
    items: MultiTeamTradeItemPayload[]
    myMemberId: string
    faabEnabled: boolean
    notes?: string
    notesError: string | null
    expirationDays?: string
    leagueStatus?: LeagueStatus | null
    tradeDeadline?: string | null
    showTerms?: boolean
    expirationError: string | null
    rosterError: string | null
    rosterLoading: boolean
    avgMap: Map<string, number>
    avgStatsMap: Map<string, { avg_minutes_played: number | null }>
    assetLabels?: ReadonlyMap<string, string>
    participantName: (memberId: string) => string
    onRetry: () => void
    onTogglePlayer: (memberId: string, playerId: string) => void
    onTogglePick: (memberId: string, pickId: string) => void
    onRemoveAsset: (memberId: string, asset: 'player' | 'pick', assetId: string) => void
    onPlayerDestinationChange: (memberId: string, playerId: string, toMemberId: string) => void
    onPickDestinationChange: (memberId: string, pickId: string, toMemberId: string) => void
    onFaabChange: (memberId: string, toMemberId: string, value: string) => void
    onNotesChange?: (value: string) => void
    onExpirationDaysChange?: (value: string) => void
    reviewOnly?: boolean
}

export function MultiTeamTradeBuilder({
    participants,
    items,
    myMemberId,
    faabEnabled,
    notes = '',
    notesError,
    expirationDays = '',
    leagueStatus,
    tradeDeadline,
    showTerms = true,
    expirationError,
    rosterError,
    rosterLoading,
    avgMap,
    avgStatsMap,
    assetLabels,
    participantName,
    onRetry,
    onTogglePlayer,
    onTogglePick,
    onRemoveAsset,
    onPlayerDestinationChange,
    onPickDestinationChange,
    onFaabChange,
    onNotesChange,
    onExpirationDaysChange,
    reviewOnly = false,
}: MultiTeamTradeBuilderProps) {
    const timezone = useLeagueTimezone()
    const { width } = useWindowDimensions()
    const [contentWidth, setContentWidth] = useState(Math.min(width, 900))
    const shellContentWidth = width >= breakpoints.compact ? width - layout.sidebarWidth : width
    const useColumns = Math.min(contentWidth, shellContentWidth) >= 880
    const notesBytes = utf8ByteLength(notes)
    const expiresAt = reviewOnly && showTerms ? buildTradeComposerPayload({
        offerPlayerIds: [], requestPlayerIds: [], offerPickIds: [], requestPickIds: [],
        notes, offerFaabInput: '0', requestFaabInput: '0', expirationDaysInput: expirationDays,
        leagueStatus, tradeDeadline,
    }).payload.expiresAt : null

    const overviewItems = useMemo<TradeFlowItem[]>(() => items.map((item) => {
        const player = item.kind === 'player'
            ? participants.flatMap((entry) => entry.roster).find((entry) => entry.players.id === item.playerId)
            : null
        const pick = item.kind === 'pick'
            ? participants.flatMap((entry) => entry.picks).find((entry) => entry.pickId === item.pickId)
            : null
        const assetKey = item.kind === 'player' ? `player:${item.playerId}`
            : item.kind === 'pick' ? `pick:${item.pickId}` : 'faab'
        const label = item.kind === 'player'
            ? player?.players.display_name ?? assetLabels?.get(assetKey) ?? 'Player'
            : item.kind === 'pick'
                ? pick ? pickLabel(pick.seasonYear, pick.round) : assetLabels?.get(assetKey) ?? 'Draft pick'
                : `$${item.faabAmount} FAAB`
        const sender = participants.find((participant) => participant.memberId === item.fromMemberId)
        const available = item.kind === 'player'
            ? sender?.roster.some((entry) => entry.players.id === item.playerId)
            : item.kind === 'pick' ? sender?.picks.some((entry) => entry.pickId === item.pickId) : true
        return {
            key: `${assetKey}:${item.fromMemberId}:${item.toMemberId}`,
            fromMemberId: item.fromMemberId,
            toMemberId: item.toMemberId,
            label,
            tradeValue: player?.tradeValue,
            playerId: item.kind === 'player' ? item.playerId : undefined,
            pick: item.kind === 'pick' && pick ? { ...pick, fromMemberId: item.fromMemberId, toMemberId: item.toMemberId } : undefined,
            player: item.kind === 'player' ? {
                playerId: item.playerId, name: label, nbaId: player?.players.nba_id, team: player?.players.nba_team,
                positions: player?.players.eligible_positions ?? (player?.players.position ? [player.players.position] : []),
                birthdate: player?.players.birthdate, yearsExp: player?.players.years_exp, careerGames: player?.players.career_regular_season_games, injuryStatus: player?.players.injury_status,
                stats: playerSeasonContextText({ avgFantasyPoints: avgMap.get(item.playerId), avgMinutesPlayed: avgStatsMap.get(item.playerId)?.avg_minutes_played }),
            } : undefined,
            detail: available ? null : 'Unavailable from this team',
        }
    }), [assetLabels, items, participants, avgMap, avgStatsMap])
    const pickContext: TradePickContext = { viewerMemberId: myMemberId, memberNames: Object.fromEntries(participants.map(participant => [participant.memberId, participantName(participant.memberId)])) }

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
            avgMap={avgMap}
            avgStatsMap={avgStatsMap}
            assetLabels={assetLabels}
            participantName={participantName}
            onTogglePlayer={onTogglePlayer}
            onTogglePick={onTogglePick}
            onRemoveAsset={onRemoveAsset}
            blockedPlayerIds={new Set(participants.filter((entry) => entry.memberId !== participant.memberId)
                .flatMap((entry) => [...entry.selectedPlayerIds]))}
            blockedPickIds={new Set(participants.filter((entry) => entry.memberId !== participant.memberId)
                .flatMap((entry) => [...entry.selectedPickIds]))}
            onPlayerDestinationChange={onPlayerDestinationChange}
            onPickDestinationChange={onPickDestinationChange}
            onFaabChange={onFaabChange}
        />
    ))

    const overviewParticipants = participants.map((participant) => ({
        memberId: participant.memberId,
        label: participant.memberId === myMemberId ? 'You' : participantName(participant.memberId),
    }))

    if (reviewOnly) {
        return (
            <DeferredContent ready={!rosterLoading}>
            <View
                style={styles.reviewRoot}
                onLayout={(event) => setContentWidth(event.nativeEvent.layout.width)}
            >
                <View style={styles.reviewHeading}>
                    <Text style={styles.reviewTitle}>
                        {participants.length}-team trade · {items.length} {items.length === 1 ? 'asset' : 'assets'}
                    </Text>
                </View>
                <MultiTeamTradeOverview pickContext={pickContext}
                    participants={overviewParticipants}
                    items={overviewItems}
                    columns={useColumns}
                    style={styles.overviewOnly}
                />
                {showTerms ? <View style={styles.reviewTerms}>
                    <Text style={styles.reviewTermsValue}>
                        {expiresAt ? `Expires ${formatLeagueDateTime(expiresAt, timezone)}` : 'No expiry'}
                    </Text>
                    {notes.trim() ? <>
                        <Text style={styles.reviewTermsLabel}>NOTE</Text>
                        <Text style={styles.reviewTermsValue}>{notes.trim()}</Text>
                    </> : null}
                </View> : null}
            </View>
            </DeferredContent>
        )
    }

    return (
        <DeferredContent ready={!rosterLoading}>
        <View style={styles.root}>
            {overviewItems.some((item) => item.detail) ? (
                <Text style={styles.routeWarning} accessibilityRole="alert">
                    Remove unavailable players or picks before you review this trade.
                </Text>
            ) : null}
            {panels}
            {showTerms ? <Card padding="none" elevated="none" style={styles.termsCard}>
                <SectionBand label="Offer terms" />
                <View style={styles.termsBody}>
                    <TextInput
                        style={[styles.notesInput, notesError && styles.notesInputInvalid]}
                        placeholder="Add a message to your trade offer..."
                        placeholderTextColor={colors.inputPlaceholder}
                        value={notes}
                        onChangeText={(value) => {
                            const nextBytes = utf8ByteLength(value)
                            if (nextBytes <= MAX_TRADE_NOTES_BYTES || nextBytes < notesBytes) onNotesChange?.(value)
                        }}
                        multiline
                        numberOfLines={3}
                        accessibilityLabel={notesError
                            ? `Trade notes. ${notesError}`
                            : `Trade notes. ${notesBytes} of ${MAX_TRADE_NOTES_BYTES} UTF-8 bytes.`
                        }
                        aria-invalid={Boolean(notesError)}
                        testID="trade-notes-input"
                    />
                    <View style={styles.notesMeta}>
                        {notesError ? (
                            <Text
                                style={styles.notesError}
                                accessibilityRole="alert"
                                accessibilityLiveRegion="polite"
                                testID="trade-notes-error"
                            >
                                {notesError}
                            </Text>
                        ) : null}
                        <Text
                            style={[styles.notesCount, notesError && styles.notesCountInvalid]}
                            accessibilityLabel={`Trade notes byte count: ${notesBytes} of ${MAX_TRADE_NOTES_BYTES}`}
                            testID="trade-notes-count"
                        >
                            {notesBytes} / {MAX_TRADE_NOTES_BYTES} bytes
                        </Text>
                    </View>
                    <View style={styles.termField}>
                        <Text style={styles.termLabel} numberOfLines={1}>Expires in days</Text>
                        <TextInput
                            style={[styles.termInput, expirationError && styles.termInputInvalid]}
                            value={expirationDays}
                            onChangeText={(value) => {
                                if (/^\d*$/.test(value) && value.length <= String(MAX_TRADE_EXPIRATION_DAYS).length) {
                                    onExpirationDaysChange?.(value)
                                }
                            }}
                            maxLength={String(MAX_TRADE_EXPIRATION_DAYS).length}
                            keyboardType="numeric"
                            accessibilityLabel={expirationError
                                ? `Trade offer expiration in days. ${expirationError}`
                                : 'Trade offer expiration in days'
                            }
                            aria-invalid={Boolean(expirationError)}
                        />
                    </View>
                    {expirationError ? (
                        <Text
                            style={styles.termError}
                            accessibilityRole="alert"
                            accessibilityLiveRegion="polite"
                            testID="trade-expiration-error"
                        >
                            {expirationError}
                        </Text>
                    ) : null}
                </View>
            </Card> : null}
        </View>
        </DeferredContent>
    )
}

const styles = StyleSheet.create({
    routeWarning: { ...typeScale.small, color: colors.warningDark },
    root: { width: '100%', maxWidth: '100%', minWidth: 0, gap: spacing.md },
    reviewRoot: { width: '100%', maxWidth: '100%', minWidth: 0, paddingBottom: spacing.md },
    reviewHeading: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
    reviewTitle: {
        ...typeScale.small,
        marginTop: spacing.xs,
        fontWeight: fontWeight.semibold,
        color: colors.textPrimary,
    },
    reviewTerms: {
        marginHorizontal: spacing.lg,
        marginTop: spacing.md,
        paddingTop: spacing.lg,
        gap: spacing.xs,
        borderTopWidth: 1,
        borderTopColor: uiColors.borderNeutral,
    },
    reviewTermsLabel: { ...textStyles.sectionLabel, marginTop: spacing.sm },
    reviewTermsValue: {
        ...typeScale.row,
        fontWeight: fontWeight.semibold,
        color: colors.textPrimary,
    },
    overviewOnly: { marginHorizontal: spacing.lg },
    termsCard: { overflow: 'hidden' },
    termsBody: { padding: componentTokens.sectionBand.paddingHorizontal, gap: spacing.sm },
    notesInput: {
        ...typeScale.title,
        borderWidth: 1,
        borderColor: uiColors.borderNeutral,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        color: colors.textPrimary,
        minHeight: controlSize.minTouch + spacing.lg,
        textAlignVertical: 'top',
    },
    notesInputInvalid: { borderColor: colors.danger },
    notesMeta: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: spacing.md,
    },
    notesError: { ...typeScale.small, flex: 1, color: colors.dangerDark, fontWeight: fontWeight.semibold },
    notesCount: { ...typeScale.small, marginLeft: 'auto', color: colors.textMuted, fontWeight: fontWeight.semibold },
    notesCountInvalid: { color: colors.dangerDark },
    termField: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minWidth: 0 },
    termLabel: { ...textStyles.rowTitle, flex: 1, minWidth: 0 },
    termInput: {
        ...typeScale.title,
        flexShrink: 0,
        width: controlSize.minTouch + spacing['6xl'],
        minHeight: controlSize.minTouch,
        borderWidth: 1,
        borderColor: uiColors.borderNeutral,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.md,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
        textAlign: 'right',
    },
    termInputInvalid: { borderColor: colors.danger },
    termError: { ...typeScale.small, color: colors.dangerDark, fontWeight: fontWeight.semibold },
    rosterErrorRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, minHeight: controlSize.minTouch, alignItems: 'center' },
    rosterErrorText: { ...typeScale.row, color: colors.dangerDark, fontWeight: fontWeight.semibold, textAlign: 'center' },
})

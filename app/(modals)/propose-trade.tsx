import {
    View,
    Text,
    Pressable,
    StyleSheet,
    ScrollView,
    TextInput,
    useWindowDimensions,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useRef, useState, useCallback } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { useMultiTeamTradeComposer, isTradeableRosterPlayer, type TradeComposerMember } from '@/hooks/use-multi-team-trade-composer'
import { getLeagueMembers, isTradingClosed } from '@/lib/league'
import { getRoster, RosterPlayer } from '@/lib/roster'
import { getRosterStatsMaps, EMPTY_AVG_MAP, EMPTY_STATS_MAP } from '@/lib/roster-stats'
import {
    counterTrade,
    counterMultiTeamTrade,
    editTrade,
    editMultiTeamTrade,
    getTradeById,
    proposeTrade,
    proposeMultiTeamTrade,
    getCurrentSeasonId,
    getPicksForMember,
    Trade,
    TradePickItem,
} from '@/lib/trades'
import {
    buildTradeComposerPayload,
    getTradeComposerMode,
    prefillTradeComposerFromRoute,
    prefillTradeComposerFromTrade,
    submitMultiTeamTradeComposer,
    submitTradeComposer,
    tradeComposerSuccessCopy,
    tradeComposerTitle,
} from '@/lib/trade-composer'
import { showAlert, showSuccess, getErrorMessage } from '@/lib/alert'

import { EmptyState } from '@/components/EmptyState'
import { TradeAssetColumn } from '@/components/trades/TradeAssetColumn'
import { MultiTeamTradeBuilder } from '@/components/trades/MultiTeamTradeBuilder'
import { colors, fontSize, fontWeight, radii, spacing, breakpoints, uiColors } from '@/constants/tokens'

export default function ProposeTradeScreen() {
    const { current, currentLeague } = useLeagueContext()
    const params = useLocalSearchParams<{
        recipientMemberId?: string
        editTradeId?: string
        counterTradeId?: string
        requestPlayerId?: string
        requestPickId?: string
    }>()
    const { back } = useRouter()

    const myMemberId = current?.id ?? ''
    const leagueId = currentLeague?.id ?? ''
    const routeRequestPlayerId = params.requestPlayerId ?? null
    const routeRequestPickId = params.requestPickId ?? null
    const { width } = useWindowDimensions()
    const twoColumn = width >= breakpoints.roster
    const myTeamName = current?.team_name ?? 'Your team'

    const [members, setMembers] = useState<TradeComposerMember[]>([])
    const [selectedRecipientId, setSelectedRecipientId] = useState<string | null>(
        params.recipientMemberId ?? null,
    )
    const [multiTeamMode, setMultiTeamMode] = useState(false)
    const [theirRoster, setTheirRoster] = useState<RosterPlayer[]>([])
    const [myRoster, setMyRoster] = useState<RosterPlayer[]>([])
    const [myPicks, setMyPicks] = useState<TradePickItem[]>([])
    const [theirPicks, setTheirPicks] = useState<TradePickItem[]>([])
    const [avgMap, setAvgMap] = useState(EMPTY_AVG_MAP)
    const [avgStatsMap, setAvgStatsMap] = useState(EMPTY_STATS_MAP)
    const [requestIds, setRequestIds] = useState<Set<string>>(new Set())
    const [offerIds, setOfferIds] = useState<Set<string>>(new Set())
    const [offerPickIds, setOfferPickIds] = useState<Set<string>>(new Set())
    const [requestPickIds, setRequestPickIds] = useState<Set<string>>(new Set())
    const [notes, setNotes] = useState('')
    const [offerFaabInput, setOfferFaabInput] = useState('0')
    const [requestFaabInput, setRequestFaabInput] = useState('0')
    const [expirationDays, setExpirationDays] = useState('3')
    const [prefillTrade, setPrefillTrade] = useState<Trade | null>(null)
    const [loading, setLoading] = useState(true)
    const [rosterLoading, setRosterLoading] = useState(false)
    const [rosterError, setRosterError] = useState<string | null>(null)
    const [submitting, setSubmitting] = useState(false)
    const submittingRef = useRef(false)
    const prefillAppliedToRef = useRef<string | null>(null)
    const rosterLoadSeqRef = useRef(0)
    const {
        mode,
        editTradeId,
        counterTradeId,
        sourceTradeId,
    } = getTradeComposerMode(params)
    const faabEnabled = currentLeague?.waiver_mode === 'faab'
    const canUseMultiTeamMode = mode === 'propose'
    const multiTeam = useMultiTeamTradeComposer({
        enabled: multiTeamMode,
        myMemberId,
        leagueId,
        myTeamName,
        members,
        faabEnabled,
    })
    const prefillMultiTeamTrade = multiTeam.prefillFromTrade

    // Load league members (excluding self)
    useEffect(() => {
        if (!leagueId) return
        getLeagueMembers(leagueId)
            .then((all) => {
                setMembers(all.filter((m) => m.id !== myMemberId))
            })
            .catch(console.error)
            .finally(() => setLoading(false))
    }, [leagueId, myMemberId])

    useEffect(() => {
        if (!sourceTradeId || !myMemberId) return
        let cancelled = false
        getTradeById(sourceTradeId, myMemberId)
            .then((trade) => {
                if (cancelled || !trade) return
                const prefill = prefillTradeComposerFromTrade(mode, trade)
                setPrefillTrade(trade)
                if (trade.isMultiTeam) {
                    setMultiTeamMode(true)
                    prefillMultiTeamTrade(trade, myMemberId)
                    setSelectedRecipientId(null)
                } else {
                    setSelectedRecipientId(prefill.selectedRecipientId)
                }
                setNotes(prefill.notes)
                setExpirationDays(prefill.expirationDays)
            })
            .catch((error) => showAlert('Error', getErrorMessage(error) ?? 'Could not load trade.'))
        return () => {
            cancelled = true
        }
    }, [sourceTradeId, myMemberId, mode, prefillMultiTeamTrade])

    // Load rosters and picks when recipient changes
    const loadRosters = useCallback(async () => {
        const requestId = ++rosterLoadSeqRef.current
        const recipientId = selectedRecipientId
        if (multiTeamMode || !recipientId || !leagueId || !myMemberId) {
            setTheirRoster([])
            setTheirPicks([])
            setAvgMap(EMPTY_AVG_MAP)
            setAvgStatsMap(EMPTY_STATS_MAP)
            setRosterLoading(false)
            return
        }
        setRosterLoading(true)
        setRosterError(null)
        setRequestIds(new Set())
        setOfferIds(new Set())
        setOfferPickIds(new Set())
        setRequestPickIds(new Set())
        try {
            const [theirData, myData, theirPicksData, myPicksData] = await Promise.all([
                getRoster(recipientId, leagueId),
                getRoster(myMemberId, leagueId),
                getPicksForMember(recipientId, leagueId),
                getPicksForMember(myMemberId, leagueId),
            ])
            if (rosterLoadSeqRef.current !== requestId) return
            const theirActiveRoster = theirData.filter(isTradeableRosterPlayer)
            const myActiveRoster = myData.filter(isTradeableRosterPlayer)
            const stats = await getRosterStatsMaps(
                [...theirActiveRoster, ...myActiveRoster].map((player) => player.players.id),
                leagueId,
            )
            if (rosterLoadSeqRef.current !== requestId) return
            const theirActiveIds = new Set(theirActiveRoster.map((player) => player.players.id))
            const myActiveIds = new Set(myActiveRoster.map((player) => player.players.id))
            setTheirRoster(theirActiveRoster)
            setMyRoster(myActiveRoster)
            setTheirPicks(theirPicksData)
            setMyPicks(myPicksData)
            setAvgMap(stats.avgMap)
            setAvgStatsMap(stats.avgStatsMap)
            if (prefillTrade && prefillAppliedToRef.current !== prefillTrade.id) {
                const prefill = prefillTradeComposerFromTrade(mode, prefillTrade)
                setOfferIds(new Set(prefill.offerPlayerIds.filter((id) => myActiveIds.has(id))))
                setOfferPickIds(new Set(prefill.offerPickIds))
                setRequestIds(new Set(prefill.requestPlayerIds.filter((id) => theirActiveIds.has(id))))
                setRequestPickIds(new Set(prefill.requestPickIds))
                setOfferFaabInput(prefill.offerFaabInput)
                setRequestFaabInput(prefill.requestFaabInput)
                prefillAppliedToRef.current = prefillTrade.id
            } else if (!prefillTrade) {
                const routePrefill = prefillTradeComposerFromRoute(recipientId, {
                    requestPlayerId: routeRequestPlayerId,
                    requestPickId: routeRequestPickId,
                })
                if (prefillAppliedToRef.current !== routePrefill.key) {
                    const activeRequestPlayerIds = routePrefill.requestPlayerIds.filter((id) => theirActiveIds.has(id))
                    if (activeRequestPlayerIds.length > 0) setRequestIds(new Set(activeRequestPlayerIds))
                    if (routePrefill.requestPickIds.length > 0) setRequestPickIds(new Set(routePrefill.requestPickIds))
                    prefillAppliedToRef.current = routePrefill.key
                }
            }
        } catch (e) {
            if (rosterLoadSeqRef.current !== requestId) return
            console.error(e)
            setRosterError(getErrorMessage(e) ?? 'Unknown error')
        } finally {
            if (rosterLoadSeqRef.current === requestId) setRosterLoading(false)
        }
    }, [multiTeamMode, selectedRecipientId, leagueId, myMemberId, prefillTrade, mode, routeRequestPlayerId, routeRequestPickId])

    useEffect(() => {
        loadRosters()
    }, [loadRosters])

    function toggleRequest(playerId: string) {
        setRequestIds((prev) => {
            const next = new Set(prev)
            if (next.has(playerId)) next.delete(playerId)
            else next.add(playerId)
            return next
        })
    }

    function toggleOffer(playerId: string) {
        setOfferIds((prev) => {
            const next = new Set(prev)
            if (next.has(playerId)) next.delete(playerId)
            else next.add(playerId)
            return next
        })
    }

    function toggleOfferPick(pickId: string) {
        setOfferPickIds((prev) => {
            const next = new Set(prev)
            if (next.has(pickId)) next.delete(pickId)
            else next.add(pickId)
            return next
        })
    }

    function toggleRequestPick(pickId: string) {
        setRequestPickIds((prev) => {
            const next = new Set(prev)
            if (next.has(pickId)) next.delete(pickId)
            else next.add(pickId)
            return next
        })
    }

    function toggleMultiTeamMode(enabled: boolean) {
        if (!canUseMultiTeamMode) return
        setMultiTeamMode(enabled)
        setSelectedRecipientId(null)
        multiTeam.reset()
        setOfferIds(new Set())
        setRequestIds(new Set())
        setOfferPickIds(new Set())
        setRequestPickIds(new Set())
    }

    async function handleSubmit() {
        if (submittingRef.current) return
        if (multiTeamMode) {
            if (isTradingClosed(currentLeague)) {
                showAlert('Trades Unavailable', 'Trades are locked only from the trade deadline until the champion is finalized.')
                return
            }
            const participantIds = multiTeam.participantIds
            const items = multiTeam.buildMultiTeamItems()
            if (participantIds.length < 2 || items.length === 0) return
            submittingRef.current = true
            setSubmitting(true)
            try {
                await submitMultiTeamTradeComposer({
                    mode,
                    editTradeId,
                    counterTradeId,
                    myMemberId,
                    leagueId,
                    participantMemberIds: participantIds,
                    items,
                    notes,
                    expirationDays,
                    leagueStatus: currentLeague?.status,
                    tradeDeadline: currentLeague?.trade_deadline,
                }, { getCurrentSeasonId, proposeMultiTeamTrade, counterMultiTeamTrade, editMultiTeamTrade })
                const successCopy = tradeComposerSuccessCopy(mode)
                showSuccess(successCopy.title, successCopy.message)
                back()
            } catch (e) {
                showAlert('Error', getErrorMessage(e) ?? 'Could not propose trade.')
            } finally {
                submittingRef.current = false
                setSubmitting(false)
            }
            return
        }
        if (!selectedRecipientId) return
        if (isTradingClosed(currentLeague)) {
            showAlert('Trades Unavailable', 'Trades are locked only from the trade deadline until the champion is finalized.')
            return
        }
        const draft = buildTradeComposerPayload({
            offerPlayerIds: offerIds,
            requestPlayerIds: requestIds,
            offerPickIds,
            requestPickIds,
            notes,
            offerFaabInput,
            requestFaabInput,
            expirationDaysInput: expirationDays,
            leagueStatus: currentLeague?.status,
            tradeDeadline: currentLeague?.trade_deadline,
        })
        if (!draft.hasOffer || !draft.hasRequest) return
        submittingRef.current = true
        setSubmitting(true)
        try {
            await submitTradeComposer(
                {
                    mode,
                    editTradeId,
                    counterTradeId,
                    myMemberId,
                    leagueId,
                    selectedRecipientId,
                    payload: draft.payload,
                },
                { getCurrentSeasonId, proposeTrade, counterTrade, editTrade },
            )

            const successCopy = tradeComposerSuccessCopy(mode)
            showSuccess(successCopy.title, successCopy.message)
            back()
        } catch (e) {
            showAlert('Error', getErrorMessage(e) ?? 'Could not propose trade.')
        } finally {
            submittingRef.current = false
            setSubmitting(false)
        }
    }

    const recipientTeamName =
        members.find((m) => m.id === selectedRecipientId)?.team_name ?? 'Opponent'

    const draft = buildTradeComposerPayload({
        offerPlayerIds: offerIds,
        requestPlayerIds: requestIds,
        offerPickIds,
        requestPickIds,
        notes,
        offerFaabInput,
        requestFaabInput,
        expirationDaysInput: expirationDays,
        leagueStatus: currentLeague?.status,
        tradeDeadline: currentLeague?.trade_deadline,
    })
    const tradingClosed = isTradingClosed(currentLeague)
    const multiIds = multiTeam.participantIds
    const multiItems = multiTeamMode ? multiTeam.buildMultiTeamItems() : []
    const activeRosterLoading = multiTeamMode ? multiTeam.rosterLoading : rosterLoading
    const canSubmit =
        multiTeamMode
            ? multiIds.length >= 2 && multiItems.length > 0 && !tradingClosed && !submitting && !activeRosterLoading
            : selectedRecipientId !== null &&
                draft.hasOffer &&
                draft.hasRequest &&
                !tradingClosed &&
                !submitting &&
                !activeRosterLoading

    if (!current) {
        return (
            <SafeAreaView style={styles.container} edges={['top']}>
                <View style={styles.emptyCenter}>
                    <Text style={styles.emptyText}>No active league.</Text>
                </View>
            </SafeAreaView>
        )
    }

    return (
        <SafeAreaView style={styles.container} edges={['top']}>
            {/* Header */}
            <View style={styles.header}>
              <View style={styles.headerInner}>
                <Pressable
                    onPress={() => back()}
                    style={styles.cancelBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel trade proposal"
                >
                    <Text style={styles.cancelBtnText}>Cancel</Text>
                </Pressable>
                <Text style={styles.headerTitle} numberOfLines={1}>
                    {tradeComposerTitle(mode)}
                </Text>
                <Pressable
                    onPress={handleSubmit}
                    style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
                    disabled={!canSubmit}
                    accessibilityRole="button"
                    accessibilityLabel="Send trade proposal"
                >
                    <Text style={[styles.submitBtnText, !canSubmit && styles.submitBtnTextDisabled]}>Send</Text>
                </Pressable>
              </View>
            </View>

            <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
                {tradingClosed ? (
                    <View style={styles.lockBanner}>
                        <Text style={styles.lockBannerText}>
                            Trades are locked only from the trade deadline until the champion is finalized.
                        </Text>
                    </View>
                ) : null}

                {/* Team picker */}
                <Text style={styles.sectionLabel}>TRADE WITH</Text>
                {canUseMultiTeamMode ? (
                    <View style={styles.modeSwitch}>
                        <Pressable
                            style={[styles.modeButton, !multiTeamMode && styles.modeButtonActive]}
                            onPress={() => toggleMultiTeamMode(false)}
                            accessibilityRole="button"
                            accessibilityLabel="Use two-team trade mode"
                        >
                            <Text style={[styles.modeButtonText, !multiTeamMode && styles.modeButtonTextActive]}>2-Team</Text>
                        </Pressable>
                        <Pressable
                            style={[styles.modeButton, multiTeamMode && styles.modeButtonActive]}
                            onPress={() => toggleMultiTeamMode(true)}
                            accessibilityRole="button"
                            accessibilityLabel="Use multi-team trade mode"
                        >
                            <Text style={[styles.modeButtonText, multiTeamMode && styles.modeButtonTextActive]}>Multi-Team</Text>
                        </Pressable>
                    </View>
                ) : null}
                <View style={styles.teamChips}>
                    {members.map((m) => {
                        const active = multiTeamMode ? multiTeam.selectedParticipantIds.has(m.id) : selectedRecipientId === m.id
                        return (
                            <Pressable
                                key={m.id}
                                style={[styles.teamChip, active && styles.teamChipActive]}
                                onPress={() => multiTeamMode ? multiTeam.toggleParticipant(m.id) : setSelectedRecipientId(m.id)}
                                accessibilityRole="button"
                                accessibilityLabel={`${active ? 'Remove' : 'Trade with'} ${m.team_name ?? 'Unnamed team'}`}
                            >
                                <Text
                                    style={[
                                        styles.teamChipText,
                                        active && styles.teamChipTextActive,
                                    ]}
                                >
                                    {m.team_name ?? 'Unnamed'}
                                </Text>
                            </Pressable>
                        )
                    })}
                </View>

                {multiTeamMode && multiIds.length >= 2 && (
                    <MultiTeamTradeBuilder
                        participantIds={multiIds}
                        myMemberId={myMemberId}
                        faabEnabled={faabEnabled}
                        notes={notes}
                        expirationDays={expirationDays}
                        rosterError={multiTeam.rosterError}
                        participantRosters={multiTeam.participantRosters}
                        participantPicks={multiTeam.participantPicks}
                        participantPlayerIds={multiTeam.participantPlayerIds}
                        participantPickIds={multiTeam.participantPickIds}
                        participantDestinationIds={multiTeam.participantDestinationIds}
                        participantPlayerDestinationIds={multiTeam.participantPlayerDestinationIds}
                        participantPickDestinationIds={multiTeam.participantPickDestinationIds}
                        participantFaabInputs={multiTeam.participantFaabInputs}
                        avgMap={multiTeam.avgMap}
                        avgStatsMap={multiTeam.avgStatsMap}
                        participantName={multiTeam.participantName}
                        onRetry={multiTeam.retry}
                        onTogglePlayer={multiTeam.toggleParticipantPlayer}
                        onTogglePick={multiTeam.toggleParticipantPick}
                        onDestinationChange={multiTeam.setParticipantDestination}
                        onPlayerDestinationChange={multiTeam.setParticipantPlayerDestination}
                        onPickDestinationChange={multiTeam.setParticipantPickDestination}
                        onFaabChange={multiTeam.setParticipantFaab}
                        onNotesChange={setNotes}
                        onExpirationDaysChange={setExpirationDays}
                    />
                )}

                {!multiTeamMode && selectedRecipientId && (
                    rosterError ? (
                        <Pressable
                            style={styles.rosterErrorRow}
                            onPress={loadRosters}
                            accessibilityRole="button"
                            accessibilityLabel="Failed to load rosters. Tap to retry."
                        >
                            <Text style={styles.rosterErrorText}>Failed to load rosters. Tap to retry.</Text>
                        </Pressable>
                    ) : (
                        <>
                            {/* Two-column compare: your team (give) on the left, their
                                team (receive) on the right. Stacks on narrow viewports. */}
                            <View style={[styles.compareRow, !twoColumn && styles.compareColStack]}>
                                <TradeAssetColumn
                                    title="YOU GIVE"
                                    subtitle={myTeamName}
                                    side="give"
                                    twoColumn={twoColumn}
                                    roster={myRoster}
                                    picks={myPicks}
                                    avgMap={avgMap}
                                    avgStatsMap={avgStatsMap}
                                    selectedPlayerIds={offerIds}
                                    selectedPickIds={offerPickIds}
                                    onTogglePlayer={toggleOffer}
                                    onTogglePick={toggleOfferPick}
                                    emptyText="No players on your roster."
                                />
                                <View style={twoColumn ? styles.columnDivider : styles.columnDividerH} />
                                <TradeAssetColumn
                                    title="YOU RECEIVE"
                                    subtitle={recipientTeamName}
                                    side="receive"
                                    twoColumn={twoColumn}
                                    roster={theirRoster}
                                    picks={theirPicks}
                                    avgMap={avgMap}
                                    avgStatsMap={avgStatsMap}
                                    selectedPlayerIds={requestIds}
                                    selectedPickIds={requestPickIds}
                                    onTogglePlayer={toggleRequest}
                                    onTogglePick={toggleRequestPick}
                                    emptyText="No players on their roster."
                                />
                            </View>

                            {/* Notes */}
                            <Text style={styles.sectionLabel}>NOTES (optional)</Text>
                            <TextInput
                                style={styles.notesInput}
                                placeholder="Add a message to your trade offer..."
                                placeholderTextColor={colors.textPlaceholder}
                                value={notes}
                                onChangeText={setNotes}
                                multiline
                                numberOfLines={3}
                            />
                            <Text style={styles.sectionLabel}>TERMS</Text>
                            <View style={styles.termsRow}>
                                {faabEnabled ? (
                                    <>
                                        <View style={styles.termField}>
                                            <Text style={styles.termLabel}>You give FAAB</Text>
                                            <TextInput
                                                style={styles.termInput}
                                                value={offerFaabInput}
                                                onChangeText={(value) => {
                                                    if (/^\d*$/.test(value)) setOfferFaabInput(value)
                                                }}
                                                keyboardType="numeric"
                                            />
                                        </View>
                                        <View style={styles.termField}>
                                            <Text style={styles.termLabel}>You receive FAAB</Text>
                                            <TextInput
                                                style={styles.termInput}
                                                value={requestFaabInput}
                                                onChangeText={(value) => {
                                                    if (/^\d*$/.test(value)) setRequestFaabInput(value)
                                                }}
                                                keyboardType="numeric"
                                            />
                                        </View>
                                    </>
                                ) : null}
                                <View style={styles.termField}>
                                    <Text style={styles.termLabel}>Expires in days</Text>
                                    <TextInput
                                        style={styles.termInput}
                                        value={expirationDays}
                                        onChangeText={(value) => {
                                            if (/^\d*$/.test(value)) setExpirationDays(value)
                                        }}
                                        keyboardType="numeric"
                                    />
                                </View>
                            </View>
                        </>
                    )
                )}

                {!selectedRecipientId && !multiTeamMode && !loading && (
                    <EmptyState
                        icon="swap-horiz"
                        message="Pick a team to trade with"
                        description="Choose a team above to see both rosters side by side, then build your offer."
                        fullScreen={false}
                        framed
                    />
                )}
                {multiTeamMode && multiIds.length < 2 && !loading ? (
                    <EmptyState
                        icon="group-add"
                        message="Pick at least one more team"
                        description="Choose teams above, then select the assets each team sends."
                        fullScreen={false}
                        framed
                    />
                ) : null}

                <View style={{ height: 40 }} />
            </ScrollView>
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    scroll: { flex: 1 },
    scrollContent: { width: '100%', maxWidth: 900, alignSelf: 'center' },

    header: {
        paddingVertical: spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    headerInner: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.xl,
        width: '100%',
        maxWidth: 900,
        alignSelf: 'center',
    },
    headerTitle: {
        flex: 1,
        marginHorizontal: spacing.md,
        fontSize: 17,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
        textAlign: 'center',
    },
    cancelBtn: {
        minWidth: 72,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.lg,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    cancelBtnText: { fontSize: fontSize.lg, color: colors.textSecondary },
    submitBtn: {
        backgroundColor: colors.primary,
        paddingHorizontal: spacing.xl,
        minHeight: 44,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        minWidth: 72,
        alignItems: 'center',
        justifyContent: 'center',
    },
    submitBtnDisabled: { backgroundColor: colors.bgMuted, borderWidth: 1, borderColor: colors.borderLight, opacity: 0.55 },
    submitBtnText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: 15 },
    submitBtnTextDisabled: { color: colors.textPlaceholder },

    sectionLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textPlaceholder,
        letterSpacing: 0,
        paddingHorizontal: spacing.xl,
        paddingTop: spacing['2xl'],
        paddingBottom: spacing.md,
    },

    // Two-column compare layout
    compareRow: { flexDirection: 'row', alignItems: 'flex-start' },
    compareColStack: { flexDirection: 'column' },
    columnDivider: { width: 1, alignSelf: 'stretch', backgroundColor: colors.borderLight },
    columnDividerH: { height: 1, backgroundColor: colors.borderLight, marginVertical: spacing.md, marginHorizontal: spacing.xl },

    teamChips: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.xs,
        gap: spacing.md,
        flexDirection: 'row',
        flexWrap: 'wrap',
    },
    modeSwitch: {
        flexDirection: 'row',
        gap: spacing.sm,
        paddingHorizontal: spacing.xl,
        paddingBottom: spacing.sm,
    },
    modeButton: {
        minHeight: 40,
        paddingHorizontal: spacing.lg,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        borderWidth: 1,
        borderColor: colors.borderLight,
        justifyContent: 'center',
        alignItems: 'center',
    },
    modeButtonActive: {
        backgroundColor: colors.primary,
        borderColor: colors.primary,
    },
    modeButtonText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
    modeButtonTextActive: { color: colors.textWhite },
    teamChip: {
        paddingHorizontal: 14,
        minHeight: 44,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        alignItems: 'center',
        justifyContent: 'center',
    },
    teamChipActive: { backgroundColor: colors.primary },
    teamChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    teamChipTextActive: { color: colors.textWhite },

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
    lockBanner: {
        marginHorizontal: spacing.xl,
        marginTop: spacing.xl,
        padding: spacing.lg,
        borderRadius: radii.lg,
        borderWidth: 1,
        borderColor: colors.warningDark,
        backgroundColor: colors.warningLight,
    },
    lockBannerText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.warningDark, textAlign: 'center' },
    emptyCenter: {
        alignItems: 'center',
        padding: spacing['5xl'],
    },
    emptyText: { fontSize: fontSize.md, color: colors.textPlaceholder, textAlign: 'center' },
})

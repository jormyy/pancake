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
import { getLeagueMembers, isTradingClosed } from '@/lib/league'
import { getRoster, RosterPlayer } from '@/lib/roster'
import {
    counterTrade,
    editTrade,
    getTradeById,
    proposeTrade,
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
    submitTradeComposer,
    tradeComposerSuccessCopy,
    tradeComposerTitle,
} from '@/lib/trade-composer'
import { showAlert, showSuccess, getErrorMessage } from '@/lib/alert'

import { yearShort } from '@/lib/format'
import { Avatar } from '@/components/Avatar'
import { EmptyState } from '@/components/EmptyState'
import { colors, palette, fontSize, fontWeight, radii, spacing, breakpoints } from '@/constants/tokens'

const isTradeableRosterPlayer = (player: RosterPlayer) => !player.is_on_ir && !player.is_on_taxi

function PlayerRow({
    player,
    selected,
    onToggle,
}: {
    player: RosterPlayer
    selected: boolean
    onToggle: () => void
}) {
    const p = player.players
    const action = selected ? 'Remove' : 'Select'
    return (
        <Pressable
            style={[styles.playerRow, selected && styles.playerRowSelected]}
            onPress={onToggle}
            accessibilityRole="button"
            accessibilityLabel={`${action} ${p.display_name} for trade`}
        >
            <Avatar
                name={p.display_name}
                color={selected ? colors.primary : palette.gray300}
                size={40}
            />
            <View style={styles.playerInfo}>
                <Text style={[styles.playerName, selected && styles.playerNameSelected]}>
                    {p.display_name}
                </Text>
                <Text style={styles.playerMeta}>
                    {[p.position, p.nba_team].filter(Boolean).join(' · ')}
                    {player.is_on_ir ? ' · IR' : ''}
                </Text>
            </View>
            {selected && (
                <View style={styles.checkBadge}>
                    <Text style={styles.checkBadgeText}>+</Text>
                </View>
            )}
        </Pressable>
    )
}

function PickRow({
    pick,
    selected,
    onToggle,
}: {
    pick: TradePickItem
    selected: boolean
    onToggle: () => void
}) {
    const action = selected ? 'Remove' : 'Select'
    return (
        <Pressable
            style={[styles.playerRow, selected && styles.playerRowSelected]}
            onPress={onToggle}
            accessibilityRole="button"
            accessibilityLabel={`${action} ${pick.seasonYear} round ${pick.round} pick via ${pick.originalTeamName} for trade`}
        >
            <View style={[styles.pickCircle, selected && styles.pickCircleSelected]}>
                <Text style={styles.pickCircleText}>{yearShort(pick.seasonYear)}</Text>
            </View>
            <View style={styles.playerInfo}>
                <Text style={[styles.playerName, selected && styles.playerNameSelected]}>
                    {pick.seasonYear} Round {pick.round}
                </Text>
                <Text style={styles.playerMeta}>via {pick.originalTeamName}</Text>
            </View>
            {selected && (
                <View style={styles.checkBadge}>
                    <Text style={styles.checkBadgeText}>+</Text>
                </View>
            )}
        </Pressable>
    )
}

function TeamColumn({
    title,
    subtitle,
    side,
    twoColumn,
    roster,
    picks,
    selectedPlayerIds,
    selectedPickIds,
    onTogglePlayer,
    onTogglePick,
    emptyText,
}: {
    title: string
    subtitle: string
    side: 'give' | 'receive'
    twoColumn: boolean
    roster: RosterPlayer[]
    picks: TradePickItem[]
    selectedPlayerIds: Set<string>
    selectedPickIds: Set<string>
    onTogglePlayer: (id: string) => void
    onTogglePick: (id: string) => void
    emptyText: string
}) {
    const selectedCount =
        roster.filter((rp) => selectedPlayerIds.has(rp.players.id)).length +
        picks.filter((p) => selectedPickIds.has(p.pickId)).length

    return (
        <View style={[styles.column, !twoColumn && styles.columnStacked]}>
            <View style={styles.columnHeader}>
                <View style={styles.flex1}>
                    <Text style={[styles.columnTitle, side === 'receive' && styles.columnTitleReceive]}>{title}</Text>
                    <Text style={styles.columnSubtitle} numberOfLines={1}>{subtitle}</Text>
                </View>
                {selectedCount > 0 ? (
                    <View style={[styles.columnCount, side === 'receive' && styles.columnCountReceive]}>
                        <Text style={styles.columnCountText}>{selectedCount}</Text>
                    </View>
                ) : null}
            </View>

            {roster.length === 0 ? (
                <Text style={styles.emptyRowText}>{emptyText}</Text>
            ) : (
                roster.map((rp) => (
                    <PlayerRow
                        key={rp.id}
                        player={rp}
                        selected={selectedPlayerIds.has(rp.players.id)}
                        onToggle={() => onTogglePlayer(rp.players.id)}
                    />
                ))
            )}

            {picks.length > 0 ? (
                <>
                    <Text style={styles.subSectionLabel}>DRAFT PICKS</Text>
                    {picks.map((pick) => (
                        <PickRow
                            key={pick.pickId}
                            pick={pick}
                            selected={selectedPickIds.has(pick.pickId)}
                            onToggle={() => onTogglePick(pick.pickId)}
                        />
                    ))}
                </>
            ) : null}
        </View>
    )
}

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

    const [members, setMembers] = useState<any[]>([])
    const [selectedRecipientId, setSelectedRecipientId] = useState<string | null>(
        params.recipientMemberId ?? null,
    )
    const [theirRoster, setTheirRoster] = useState<RosterPlayer[]>([])
    const [myRoster, setMyRoster] = useState<RosterPlayer[]>([])
    const [myPicks, setMyPicks] = useState<TradePickItem[]>([])
    const [theirPicks, setTheirPicks] = useState<TradePickItem[]>([])
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
    const {
        mode,
        editTradeId,
        counterTradeId,
        sourceTradeId,
    } = getTradeComposerMode(params)
    const faabEnabled = currentLeague?.waiver_mode === 'faab'

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
                setSelectedRecipientId(prefill.selectedRecipientId)
                setNotes(prefill.notes)
                setExpirationDays(prefill.expirationDays)
            })
            .catch((error) => showAlert('Error', getErrorMessage(error) ?? 'Could not load trade.'))
        return () => {
            cancelled = true
        }
    }, [sourceTradeId, myMemberId, mode])

    // Load rosters and picks when recipient changes
    const loadRosters = useCallback(async () => {
        if (!selectedRecipientId || !leagueId || !myMemberId) return
        setRosterLoading(true)
        setRosterError(null)
        setRequestIds(new Set())
        setOfferIds(new Set())
        setOfferPickIds(new Set())
        setRequestPickIds(new Set())
        try {
            const [theirData, myData, theirPicksData, myPicksData] = await Promise.all([
                getRoster(selectedRecipientId, leagueId),
                getRoster(myMemberId, leagueId),
                getPicksForMember(selectedRecipientId, leagueId),
                getPicksForMember(myMemberId, leagueId),
            ])
            const theirActiveRoster = theirData.filter(isTradeableRosterPlayer)
            const myActiveRoster = myData.filter(isTradeableRosterPlayer)
            const theirActiveIds = new Set(theirActiveRoster.map((player) => player.players.id))
            const myActiveIds = new Set(myActiveRoster.map((player) => player.players.id))
            setTheirRoster(theirActiveRoster)
            setMyRoster(myActiveRoster)
            setTheirPicks(theirPicksData)
            setMyPicks(myPicksData)
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
                const routePrefill = prefillTradeComposerFromRoute(selectedRecipientId, {
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
            console.error(e)
            setRosterError(getErrorMessage(e) ?? 'Unknown error')
        } finally {
            setRosterLoading(false)
        }
    }, [selectedRecipientId, leagueId, myMemberId, prefillTrade, mode, routeRequestPlayerId, routeRequestPickId])

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

    async function handleSubmit() {
        if (submittingRef.current) return
        if (!selectedRecipientId) return
        if (isTradingClosed(currentLeague)) {
            showAlert('Trades Unavailable', 'Trades are available during active and playoff seasons before the trade deadline.')
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
    const canSubmit =
        selectedRecipientId !== null &&
        draft.hasOffer &&
        draft.hasRequest &&
        !tradingClosed &&
        !submitting &&
        !rosterLoading

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
                            Trades are available during active and playoff seasons before the trade deadline.
                        </Text>
                    </View>
                ) : null}

                {/* Team picker */}
                <Text style={styles.sectionLabel}>TRADE WITH</Text>
                <View style={styles.teamChips}>
                    {members.map((m) => {
                        const active = selectedRecipientId === m.id
                        return (
                            <Pressable
                                key={m.id}
                                style={[styles.teamChip, active && styles.teamChipActive]}
                                onPress={() => setSelectedRecipientId(m.id)}
                                accessibilityRole="button"
                                accessibilityLabel={`Trade with ${m.team_name ?? 'Unnamed team'}`}
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

                {selectedRecipientId && (
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
                                <TeamColumn
                                    title="YOU GIVE"
                                    subtitle={myTeamName}
                                    side="give"
                                    twoColumn={twoColumn}
                                    roster={myRoster}
                                    picks={myPicks}
                                    selectedPlayerIds={offerIds}
                                    selectedPickIds={offerPickIds}
                                    onTogglePlayer={toggleOffer}
                                    onTogglePick={toggleOfferPick}
                                    emptyText="No players on your roster."
                                />
                                <View style={twoColumn ? styles.columnDivider : styles.columnDividerH} />
                                <TeamColumn
                                    title="YOU RECEIVE"
                                    subtitle={recipientTeamName}
                                    side="receive"
                                    twoColumn={twoColumn}
                                    roster={theirRoster}
                                    picks={theirPicks}
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

                {!selectedRecipientId && !loading && (
                    <EmptyState
                        icon="swap-horiz"
                        message="Pick a team to trade with"
                        description="Choose a team above to see both rosters side by side, then build your offer."
                        fullScreen={false}
                        framed
                    />
                )}

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
    subSectionLabel: {
        fontSize: 10,
        fontWeight: fontWeight.bold,
        color: colors.textSecondary,
        letterSpacing: 0,
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.lg,
        paddingBottom: spacing.sm,
    },

    // Two-column compare layout
    compareRow: { flexDirection: 'row', alignItems: 'flex-start' },
    compareColStack: { flexDirection: 'column' },
    column: { flex: 1, minWidth: 0 },
    // flexBasis must stay 'auto': RN-web resolves `flex: 0` to flex-basis 0%,
    // which collapses the stacked column to zero height and overlaps the panels.
    columnStacked: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto', width: '100%' },
    columnDivider: { width: 1, alignSelf: 'stretch', backgroundColor: colors.borderLight },
    columnDividerH: { height: 1, backgroundColor: colors.borderLight, marginVertical: spacing.md, marginHorizontal: spacing.xl },
    columnHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.xl,
        paddingTop: spacing['2xl'],
        paddingBottom: spacing.md,
    },
    flex1: { flex: 1, minWidth: 0 },
    columnTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.extrabold, color: colors.textPrimary, letterSpacing: 0 },
    columnTitleReceive: { color: colors.primaryDark },
    columnSubtitle: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: spacing.xxs, fontWeight: fontWeight.semibold },
    columnCount: {
        minWidth: 22,
        height: 22,
        paddingHorizontal: spacing.sm,
        borderRadius: radii.full,
        backgroundColor: palette.mocha,
        alignItems: 'center',
        justifyContent: 'center',
    },
    columnCountReceive: { backgroundColor: colors.primary },
    columnCountText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textWhite },

    teamChips: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.xs,
        gap: spacing.md,
        flexDirection: 'row',
        flexWrap: 'wrap',
    },
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

    playerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        gap: spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
    },
    playerRowSelected: { backgroundColor: colors.primaryLight },

    pickCircle: {
        width: 40,
        height: 40,
        borderRadius: 20,
        borderCurve: 'continuous' as const,
        backgroundColor: palette.indigo500,
        justifyContent: 'center',
        alignItems: 'center',
    },
    pickCircleSelected: { backgroundColor: colors.primary },
    pickCircleText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: 12 },

    playerInfo: { flex: 1 },
    playerName: { fontSize: 15, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    playerNameSelected: { color: colors.primaryDark },
    playerMeta: { fontSize: 12, color: colors.textMuted, marginTop: spacing.xxs },
    checkBadge: {
        width: 24,
        height: 24,
        borderRadius: 12,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primary,
        justifyContent: 'center',
        alignItems: 'center',
    },
    checkBadgeText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.lg, lineHeight: 22 },

    notesInput: {
        marginHorizontal: spacing.xl,
        borderWidth: 1,
        borderColor: palette.gray300,
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
        borderColor: palette.gray300,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.md,
        fontSize: fontSize.md,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
    },

    emptyRowText: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        color: colors.textPlaceholder,
        fontSize: fontSize.md,
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

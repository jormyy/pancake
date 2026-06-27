import {
    View,
    Text,
    TextInput,
    StyleSheet,
    ActivityIndicator,
    ScrollView,
    KeyboardAvoidingView,
    Platform,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import {
    getDraftState,
    subscribeToDraft,
    unsubscribeFromDraft,
    nominatePlayer,
    placeBid,
    withdrawNomination,
    searchPlayers,
    DraftState,
    DraftSearchPlayer,
    NominationOrderMode,
    NOMINATION_ORDER_MODE_LABELS,
} from '@/lib/draft'
import { RealtimeChannel } from '@supabase/supabase-js'
import { LoadingScreen } from '@/components/LoadingScreen'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { showAlert, getErrorMessage } from '@/lib/alert'
import { MotionPressable, MotionView } from '@/components/Motion'

type DraftTab = 'budgets' | 'history'

export default function DraftRoomScreen() {
    const { draftId } = useLocalSearchParams<{ draftId: string }>()
    const { current } = useLeagueContext()
    const { back } = useRouter()

    const [state, setState] = useState<DraftState | null>(null)
    const [loading, setLoading] = useState(true)
    const [tab, setTab] = useState<DraftTab>('budgets')

    // Bidding — held as raw text so the field can be cleared/typed freely;
    // the value is validated and clamped only on submit (handleBid).
    const [bidText, setBidText] = useState('2')
    const [bidding, setBidding] = useState(false)
    const [withdrawing, setWithdrawing] = useState(false)

    // Nomination / player search
    const [nominating, setNominating] = useState(false)
    const [searchQuery, setSearchQuery] = useState('')
    const [searchResults, setSearchResults] = useState<DraftSearchPlayer[]>([])
    const [searchLoading, setSearchLoading] = useState(false)
    const [submittingNom, setSubmittingNom] = useState(false)

    // Countdown timer
    const [timeLeft, setTimeLeft] = useState(0)
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
    // Track which nomination the bid field was last seeded for, so the 5s poll /
    // realtime refresh never clobbers a value the user is actively typing.
    const lastNomIdRef = useRef<string | null>(null)
    // The draft's nomination-order mode is stable; keep it in a ref so the search
    // effect can read it without re-running on every poll-driven state change.
    const nominationModeRef = useRef<NominationOrderMode>('user_nominated')
    // Monotonic load token: realtime handlers + the 5s poll + post-action reloads
    // fire load() concurrently, so drop any result that a newer load supersedes.
    const loadSeqRef = useRef(0)

    const channelRef = useRef<RealtimeChannel | null>(null)
    const myMemberId = current?.id
    const countdownNomination = state?.openNomination

    const load = useCallback(async () => {
        if (!draftId) return
        const seq = ++loadSeqRef.current
        try {
            const s = await getDraftState(draftId)
            // Ignore a stale, out-of-order result once a newer load has started.
            if (seq !== loadSeqRef.current) return
            // Only commit a DEFINITE state. getDraftState() returns null (not a
            // throw) on a transient fetch failure; committing null would blank the
            // whole live auction room (LoadingScreen) for seconds during bidding,
            // and would also reseed the bid field on the next good poll.
            if (s) {
                setState(s)
                nominationModeRef.current = s.draft.nominationOrderMode
                const nom = s.openNomination ?? null
                if (nom?.countdownExpiresAt) {
                    const diff = Math.max(
                        0,
                        Math.floor((new Date(nom.countdownExpiresAt).getTime() - Date.now()) / 1000),
                    )
                    setTimeLeft(diff)
                }
                // Seed the default bid ONLY when a new player comes on the block —
                // not on every poll — so typed bids survive refreshes. Min-bid
                // changes within a nomination are handled by the submit guard.
                const nomId = nom?.id ?? null
                if (nomId !== lastNomIdRef.current) {
                    lastNomIdRef.current = nomId
                    if (nom) setBidText(String(Math.max((nom.currentBidAmount ?? 1) + 1, 2)))
                }
            }
        } catch (e) {
            console.error(e)
        } finally {
            setLoading(false)
        }
    }, [draftId])

    // Load + subscribe + poll fallback
    useEffect(() => {
        if (!draftId) return
        load()
        channelRef.current = subscribeToDraft(draftId, load)
        const poll = setInterval(load, 5000)
        return () => {
            if (channelRef.current) unsubscribeFromDraft(channelRef.current)
            clearInterval(poll)
        }
    }, [draftId, load])

    // Countdown tick
    useEffect(() => {
        if (timerRef.current) clearInterval(timerRef.current)
        if (!countdownNomination) return

        timerRef.current = setInterval(() => {
            const exp = countdownNomination.countdownExpiresAt
            if (!exp) return
            const diff = Math.max(0, Math.floor((new Date(exp).getTime() - Date.now()) / 1000))
            setTimeLeft(diff)
        }, 500)

        return () => {
            if (timerRef.current) clearInterval(timerRef.current)
        }
    }, [countdownNomination])

    // Player search
    useEffect(() => {
        if (!nominating || !draftId) {
            setSearchResults([])
            return
        }
        const timeout = setTimeout(async () => {
            setSearchLoading(true)
            try {
                const results = await searchPlayers(searchQuery, draftId, nominationModeRef.current)
                setSearchResults(results)
            } finally {
                setSearchLoading(false)
            }
        }, 300)
        return () => clearTimeout(timeout)
    }, [searchQuery, draftId, nominating])

    async function handleBid() {
        if (!state?.openNomination || !myMemberId || !draftId) return
        // Guard the typed bid only at submit time: must be a whole-dollar amount
        // at least the minimum and within remaining budget.
        const min = Math.max(1, (state.openNomination.currentBidAmount ?? 0) + 1)
        // Match bidValid's fallback; the RPC is the authoritative budget check.
        const remaining = state.budgets.find((b) => b.memberId === myMemberId)?.remaining ?? Infinity
        const amount = parseInt(bidText, 10)
        if (isNaN(amount) || amount < min) {
            showAlert('Invalid bid', `Enter a whole-dollar bid of at least $${min}.`)
            return
        }
        if (amount > remaining) {
            showAlert('Over budget', `You only have $${remaining} left to spend.`)
            return
        }
        setBidding(true)
        try {
            await placeBid(draftId, myMemberId, state.openNomination.id, amount)
            load()
        } catch (e) {
            showAlert('Bid failed', getErrorMessage(e))
        } finally {
            setBidding(false)
        }
    }

    async function handleWithdraw() {
        if (!state?.openNomination || !myMemberId || !draftId) return
        setWithdrawing(true)
        try {
            await withdrawNomination(draftId, myMemberId, state.openNomination.id)
            load()
        } catch (e) {
            showAlert('Could not withdraw', getErrorMessage(e))
        } finally {
            setWithdrawing(false)
        }
    }

    async function handleNominate(playerId: string) {
        if (!myMemberId || !draftId) return
        setSubmittingNom(true)
        try {
            await nominatePlayer(draftId, myMemberId, playerId)
            setNominating(false)
            setSearchQuery('')
            setSearchResults([])
            load()
        } catch (e) {
            showAlert('Nomination failed', getErrorMessage(e))
        } finally {
            setSubmittingNom(false)
        }
    }

    // Memoize O(N) derivations from state so we don't recompute them every render
    // (poll fires every 5s; without memos every parent re-render rebuilds these arrays/maps).
    const closedNominations = useMemo(
        () =>
            state
                ? state.nominations.filter((n) => n.status !== 'open').reverse()
                : [],
        [state],
    )
    const budgetByMember = useMemo(
        () => new Map((state?.budgets ?? []).map((b) => [b.memberId, b])),
        [state],
    )

    if (loading || !state) {
        return <LoadingScreen />
    }

    const { draft, order, budgets, openNomination, currentNominatorMemberId } = state
    const isMyTurn = currentNominatorMemberId === myMemberId
    const currentNominatorTeam =
        order.find((o) => o.memberId === currentNominatorMemberId)?.teamName ?? 'Unknown'

    const myBudget = myMemberId ? budgetByMember.get(myMemberId) : undefined
    const iAmLeading = openNomination?.currentBidderId === myMemberId
    const leadingTeam = openNomination?.currentBidderId
        ? budgetByMember.get(openNomination.currentBidderId)?.teamName
        : undefined

    const iAmBankrupt = (myBudget?.remaining ?? 0) < 1
    // Min bid is current + 1, floored at 1
    const minBid = Math.max(1, (openNomination?.currentBidAmount ?? 0) + 1)
    const remainingBudget = myBudget?.remaining ?? Infinity
    const bidValue = parseInt(bidText, 10) // NaN while the field is empty/partial
    const bidValid = !isNaN(bidValue) && bidValue >= minBid && bidValue <= remainingBudget

    if (draft.status === 'completed') {
        return (
            <SafeAreaView style={styles.container} edges={['bottom']}>
                <View style={styles.header}>
                    <Text style={styles.headerTitle}>Auction Draft</Text>
                </View>
                <View style={styles.draftEndedContainer}>
                    <Text style={styles.draftEndedTitle}>Draft Complete</Text>
                    <Text style={styles.draftEndedSub}>
                        All teams are out of budget. Remaining players are free agents.
                    </Text>
                    <MotionPressable style={styles.nominateButton} onPress={() => back()} pressedScale={0.96}>
                        <Text style={styles.nominateButtonText}>Back to League</Text>
                    </MotionPressable>
                </View>
            </SafeAreaView>
        )
    }

    return (
        <SafeAreaView style={styles.container} edges={['bottom']}>
            {/* Header */}
            <View style={styles.header}>
                <View style={styles.headerInner}>
                    <Text style={styles.headerTitle}>Auction Draft</Text>
                    {myBudget && (
                        <View style={styles.budgetChip}>
                            <Text style={styles.budgetChipText}>${myBudget.remaining} left</Text>
                        </View>
                    )}
                </View>
            </View>

            <KeyboardAvoidingView
                style={styles.keyboard}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
            <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                keyboardShouldPersistTaps="handled"
            >
                {/* Nomination on the clock */}
                {openNomination ? (
                    <MotionView style={styles.card} preset="pop">
                        <Text style={styles.cardLabel}>ON THE BLOCK</Text>
                        <Text style={styles.playerName}>
                            {openNomination.player?.displayName ?? 'Unknown Player'}
                        </Text>
                        <Text style={styles.playerMeta}>
                            {openNomination.player?.nbaTeam ?? '—'} ·{' '}
                            {openNomination.player?.position ?? '—'}
                        </Text>

                        <View style={styles.bidRow}>
                            <View style={styles.bidInfo}>
                                <Text style={styles.bidAmount}>
                                    {openNomination.currentBidAmount > 0
                                        ? `$${openNomination.currentBidAmount}`
                                        : '—'}
                                </Text>
                                <Text style={styles.bidLeader}>
                                    {openNomination.currentBidderId == null
                                        ? 'No bids yet'
                                        : iAmLeading
                                          ? "You're leading"
                                          : `${leadingTeam} leads`}
                                </Text>
                            </View>
                            <View
                                style={[styles.countdown, timeLeft <= 10 && styles.countdownUrgent]}
                            >
                                <Text
                                    style={[
                                        styles.countdownText,
                                        timeLeft <= 10 && styles.countdownTextUrgent,
                                    ]}
                                >
                                    0:{String(timeLeft).padStart(2, '0')}
                                </Text>
                            </View>
                        </View>

                        {!iAmLeading && !iAmBankrupt && (
                            <View style={styles.bidInputRow}>
                                <MotionPressable
                                    style={styles.bidStep}
                                    onPress={() =>
                                        setBidText((t) => String(Math.max(minBid, (parseInt(t, 10) || minBid) - 1)))
                                    }
                                    accessibilityRole="button"
                                    accessibilityLabel="Decrease bid"
                                    hitSlop={8}
                                    pressedScale={0.88}
                                >
                                    <Text style={styles.bidStepText}>−</Text>
                                </MotionPressable>
                                <TextInput
                                    style={styles.bidAmountInput}
                                    value={bidText}
                                    onChangeText={(v) => setBidText(v.replace(/[^0-9]/g, ''))}
                                    keyboardType="number-pad"
                                    selectTextOnFocus
                                    accessibilityLabel="Bid amount"
                                />
                                <MotionPressable
                                    style={styles.bidStep}
                                    onPress={() =>
                                        setBidText((t) =>
                                            String(Math.min(remainingBudget, (parseInt(t, 10) || minBid - 1) + 1)),
                                        )
                                    }
                                    accessibilityRole="button"
                                    accessibilityLabel="Increase bid"
                                    hitSlop={8}
                                    pressedScale={0.88}
                                >
                                    <Text style={styles.bidStepText}>+</Text>
                                </MotionPressable>
                                <MotionPressable
                                    style={[styles.bidButton, (bidding || !bidValid) && styles.bidButtonDisabled]}
                                    onPress={handleBid}
                                    accessibilityRole="button"
                                    accessibilityLabel={`Bid $${(bidValid ? bidValue : minBid).toLocaleString()}`}
                                    disabled={bidding || !bidValid || iAmLeading || timeLeft === 0}
                                    pressedScale={0.965}
                                >
                                    {bidding ? (
                                        <ActivityIndicator size="small" color={colors.textWhite} />
                                    ) : (
                                        <Text style={styles.bidButtonText}>
                                            Bid ${(bidValid ? bidValue : minBid).toLocaleString()}
                                        </Text>
                                    )}
                                </MotionPressable>
                            </View>
                        )}

                        {openNomination.nominatingMemberId === myMemberId &&
                            openNomination.currentBidderId == null && (
                                <MotionPressable
                                    style={styles.withdrawButton}
                                    onPress={handleWithdraw}
                                    disabled={withdrawing}
                                    accessibilityRole="button"
                                    accessibilityLabel="Withdraw nomination"
                                    pressedScale={0.96}
                                >
                                    {withdrawing ? (
                                        <ActivityIndicator size="small" color={colors.primary} />
                                    ) : (
                                        <Text style={styles.withdrawButtonText}>Withdraw nomination</Text>
                                    )}
                                </MotionPressable>
                            )}
                    </MotionView>
                ) : (
                    /* No open nomination — show whose turn it is */
                    <MotionView style={styles.card} preset="pop">
                        {isMyTurn ? (
                            <>
                                <Text style={styles.yourTurnBanner}>Your turn to nominate!</Text>
                                <Text style={styles.nominationModeHint}>
                                    Nomination order: {NOMINATION_ORDER_MODE_LABELS[draft.nominationOrderMode]}
                                </Text>
                                {nominating ? (
                                    <>
                                        <TextInput
                                            style={styles.searchInput}
                                            value={searchQuery}
                                            onChangeText={setSearchQuery}
                                            placeholder="Search player name..."
                                            autoFocus
                                        />
                                        {searchLoading ? (
                                            <ActivityIndicator
                                                style={{ marginTop: 12 }}
                                                color={colors.primary}
                                            />
                                        ) : (
                                            <FlashList
                                                data={searchResults}
                                                keyExtractor={(p) => p.id}
                                                scrollEnabled={false}
                                                renderItem={({ item }) => (
                                                    <MotionPressable
                                                        style={styles.playerResult}
                                                        onPress={() =>
                                                            handleNominate(item.id)
                                                        }
                                                        disabled={submittingNom}
                                                        pressedScale={0.975}
                                                    >
                                                        <View style={styles.flex1}>
                                                            <Text style={styles.playerResultName}>
                                                                {item.display_name}
                                                            </Text>
                                                            <Text style={styles.playerResultMeta}>
                                                                {item.dynasty_rank != null
                                                                    ? `#${item.dynasty_rank} · `
                                                                    : ''}
                                                                {item.nba_team ?? '—'} · {item.position ?? '—'}
                                                            </Text>
                                                        </View>
                                                        {submittingNom ? (
                                                            <ActivityIndicator
                                                                size="small"
                                                                color={colors.primary}
                                                            />
                                                        ) : (
                                                            <Text style={styles.nominateLabel}>
                                                                Nominate
                                                            </Text>
                                                        )}
                                                    </MotionPressable>
                                                )}
                                                ListEmptyComponent={
                                                    searchQuery.length > 0 && !searchLoading ? (
                                                        <Text style={styles.emptySearch}>
                                                            No players found
                                                        </Text>
                                                    ) : null
                                                }
                                            />
                                        )}
                                        <MotionPressable
                                            style={styles.cancelNomButton}
                                            onPress={() => {
                                                setNominating(false)
                                                setSearchQuery('')
                                                setSearchResults([])
                                            }}
                                            pressedScale={0.94}
                                        >
                                            <Text style={styles.cancelNomText}>Cancel</Text>
                                        </MotionPressable>
                                    </>
                                ) : (
                                    <MotionPressable
                                        style={styles.nominateButton}
                                        onPress={() => setNominating(true)}
                                        pressedScale={0.965}
                                    >
                                        <Text style={styles.nominateButtonText}>
                                            Search & Nominate a Player
                                        </Text>
                                    </MotionPressable>
                                )}
                            </>
                        ) : (
                            <View style={styles.waitingRow}>
                                <Text style={styles.waitingText}>Waiting for</Text>
                                <Text style={styles.waitingTeam}>{currentNominatorTeam}</Text>
                                <Text style={styles.waitingText}>to nominate...</Text>
                            </View>
                        )}
                    </MotionView>
                )}

                {/* Tab switcher */}
                <View style={styles.tabRow}>
                    {(['budgets', 'history'] as DraftTab[]).map((t) => (
                        <MotionPressable
                            key={t}
                            style={[styles.tabChip, tab === t && styles.tabChipActive]}
                            onPress={() => setTab(t)}
                            pressedScale={0.94}
                        >
                            <Text
                                style={[styles.tabChipText, tab === t && styles.tabChipTextActive]}
                            >
                                {t === 'budgets'
                                    ? 'Budgets'
                                    : `History (${closedNominations.length})`}
                            </Text>
                        </MotionPressable>
                    ))}
                </View>

                {tab === 'budgets' ? (
                    <MotionView style={styles.card} preset="rise" delay={80}>
                        {budgets
                            .slice()
                            .sort((a, b) => b.remaining - a.remaining)
                            .map((b, i) => (
                                <View
                                    key={b.memberId}
                                    style={[styles.budgetRow, i > 0 && styles.budgetDivider]}
                                >
                                    <Text
                                        style={[
                                            styles.budgetTeam,
                                            b.memberId === myMemberId && styles.meAccent,
                                        ]}
                                        numberOfLines={1}
                                    >
                                        {b.teamName}
                                        {b.memberId === myMemberId ? ' (you)' : ''}
                                    </Text>
                                    <Text
                                        style={[
                                            styles.budgetAmount,
                                            b.memberId === myMemberId && styles.meAccent,
                                        ]}
                                    >
                                        ${b.remaining}
                                    </Text>
                                </View>
                            ))}
                    </MotionView>
                ) : closedNominations.length === 0 ? (
                    <View style={styles.empty}>
                        <Text style={styles.emptyText}>No players sold yet.</Text>
                    </View>
                ) : (
                    <MotionView style={styles.card} preset="rise" delay={80}>
                        {closedNominations.map((n, i) => {
                            const winnerTeam = n.winningMemberId
                                ? budgetByMember.get(n.winningMemberId)?.teamName
                                : undefined
                            return (
                                <View
                                    key={n.id}
                                    style={[styles.historyRow, i > 0 && styles.budgetDivider]}
                                >
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.historyPlayer}>
                                            {n.player?.displayName ?? 'Unknown'}
                                        </Text>
                                        <Text style={styles.historyMeta}>
                                            {n.status === 'sold' ? (winnerTeam ?? '—') : 'No bid'}
                                        </Text>
                                    </View>
                                    {n.status === 'sold' && (
                                        <Text style={styles.historyPrice}>${n.finalPrice}</Text>
                                    )}
                                    {n.status === 'no_bid' && (
                                        <Text style={styles.historyNoBid}>FA</Text>
                                    )}
                                </View>
                            )
                        })}
                    </MotionView>
                )}
            </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgSubtle },
    flex1: { flex: 1 },
    keyboard: { flex: 1 },
    scroll: { flex: 1 },
    scrollContent: { padding: spacing.xl, paddingBottom: spacing['3xl'], gap: spacing.lg, width: '100%', maxWidth: 760, alignSelf: 'center' },

    header: {
        paddingVertical: 14,
        backgroundColor: colors.bgScreen,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    headerInner: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.xl,
        width: '100%',
        maxWidth: 760,
        alignSelf: 'center',
    },
    headerTitle: { fontSize: 18, fontWeight: fontWeight.extrabold },
    budgetChip: {
        backgroundColor: colors.primaryLight,
        paddingHorizontal: spacing.lg,
        paddingVertical: 5,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
    },
    budgetChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },

    card: {
        backgroundColor: colors.bgScreen,
        borderRadius: 14,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        padding: spacing.xl,
        gap: spacing.md,
    },
    cardLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textPlaceholder, letterSpacing: 0.5 },

    playerName: { fontSize: 22, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    playerMeta: { fontSize: fontSize.sm, color: colors.textMuted },

    bidRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: spacing.xs,
    },
    bidInfo: { gap: spacing.xxs },
    bidAmount: { fontSize: fontSize['3xl'], fontWeight: fontWeight.extrabold, color: colors.primaryDark },
    bidLeader: { fontSize: fontSize.sm, color: colors.textMuted },

    countdown: {
        width: 60,
        height: 60,
        borderRadius: 30,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        justifyContent: 'center',
        alignItems: 'center',
    },
    countdownUrgent: { backgroundColor: colors.dangerLight },
    countdownText: { fontSize: 18, fontWeight: fontWeight.extrabold, color: colors.textSecondary },
    countdownTextUrgent: { color: colors.danger },

    bidInputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.xs },
    bidStep: {
        width: 36,
        height: 36,
        borderRadius: 18,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        justifyContent: 'center',
        alignItems: 'center',
    },
    bidStepText: { fontSize: 20, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    bidAmountInput: {
        fontSize: 18,
        fontWeight: fontWeight.extrabold,
        minWidth: 56,
        textAlign: 'center',
        backgroundColor: colors.bgMuted,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        paddingHorizontal: 10,
        paddingVertical: spacing.sm,
    },
    bidButton: {
        flex: 1,
        height: 44,
        backgroundColor: colors.primary,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
    },
    bidButtonDisabled: { opacity: 0.5 },
    bidButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: 15 },

    yourTurnBanner: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: colors.primaryDark, textAlign: 'center' },
    nominationModeHint: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', marginTop: spacing.xs },
    nominateButton: {
        marginTop: spacing.xs,
        height: 48,
        backgroundColor: colors.primary,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
    },
    nominateButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: 15 },

    searchInput: {
        height: 44,
        backgroundColor: colors.bgMuted,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        paddingHorizontal: 14,
        fontSize: 15,
        marginTop: spacing.xs,
    },

    playerResult: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        borderTopWidth: 1,
        borderTopColor: colors.separator,
        gap: spacing.md,
    },
    playerResultName: { fontSize: 15, fontWeight: fontWeight.semibold },
    playerResultMeta: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
    nominateLabel: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
    emptySearch: { fontSize: fontSize.sm, color: colors.textPlaceholder, textAlign: 'center', marginTop: spacing.md },
    cancelNomButton: { marginTop: spacing.md, alignItems: 'center' },
    cancelNomText: { fontSize: fontSize.md, color: colors.textMuted, fontWeight: fontWeight.semibold },
    withdrawButton: {
        marginTop: spacing.md,
        alignItems: 'center',
        paddingVertical: spacing.sm,
        borderRadius: radii.lg,
        borderWidth: 1,
        borderColor: colors.border,
    },
    withdrawButtonText: { fontSize: fontSize.md, color: colors.textMuted, fontWeight: fontWeight.semibold },

    waitingRow: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.md },
    waitingText: { fontSize: fontSize.md, color: colors.textMuted },
    waitingTeam: { fontSize: 18, fontWeight: fontWeight.extrabold, color: colors.textPrimary },

    tabRow: { flexDirection: 'row', gap: spacing.md },
    tabChip: {
        paddingHorizontal: 14,
        paddingVertical: spacing.md,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    tabChipActive: { backgroundColor: colors.primary },
    tabChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    tabChipTextActive: { color: colors.textWhite },

    budgetRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
    budgetDivider: { borderTopWidth: 1, borderTopColor: colors.separator },
    budgetTeam: { flex: 1, fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    budgetAmount: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    meAccent: { color: colors.primaryDark },

    historyRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
    historyPlayer: { fontSize: fontSize.md, fontWeight: fontWeight.semibold },
    historyMeta: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
    historyPrice: { fontSize: 15, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    historyNoBid: {
        fontSize: 12,
        fontWeight: fontWeight.bold,
        color: colors.textPlaceholder,
        backgroundColor: colors.bgMuted,
        paddingHorizontal: spacing.md,
        paddingVertical: 3,
        borderRadius: radii.sm,
        borderCurve: 'continuous' as const,
    },

    empty: { alignItems: 'center', paddingVertical: spacing['3xl'] },
    emptyText: { fontSize: fontSize.sm, color: colors.textPlaceholder },

    draftEndedContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing['4xl'], gap: spacing.lg },
    draftEndedTitle: { fontSize: fontSize['2xl'], fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    draftEndedSub: { fontSize: fontSize.md, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
})

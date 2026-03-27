import {
    View,
    Text,
    TextInput,
    Pressable,
    StyleSheet,
    ActivityIndicator,
    Alert,
    ScrollView,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useRef, useState, useCallback } from 'react'
import { useAuth } from '@/hooks/use-auth'
import { useLeagueContext } from '@/contexts/league-context'
import {
    getDraftState,
    subscribeToDraft,
    unsubscribeFromDraft,
    nominatePlayer,
    placeBid,
    searchPlayers,
    DraftState,
    Nomination,
} from '@/lib/draft'
import { RealtimeChannel } from '@supabase/supabase-js'
import { LoadingScreen } from '@/components/LoadingScreen'
import { colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'

type DraftTab = 'budgets' | 'history'

export default function DraftRoomScreen() {
    const { draftId } = useLocalSearchParams<{ draftId: string }>()
    const { user } = useAuth()
    const { current } = useLeagueContext()
    const { back } = useRouter()

    const [state, setState] = useState<DraftState | null>(null)
    const [loading, setLoading] = useState(true)
    const [tab, setTab] = useState<DraftTab>('budgets')

    // Bidding
    const [bidAmount, setBidAmount] = useState(2)
    const [bidding, setBidding] = useState(false)

    // Nomination / player search
    const [nominating, setNominating] = useState(false)
    const [searchQuery, setSearchQuery] = useState('')
    const [searchResults, setSearchResults] = useState<any[]>([])
    const [searchLoading, setSearchLoading] = useState(false)
    const [submittingNom, setSubmittingNom] = useState(false)

    // Countdown timer
    const [timeLeft, setTimeLeft] = useState(0)
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

    const channelRef = useRef<RealtimeChannel | null>(null)
    const myMemberId = current?.id

    const load = useCallback(async () => {
        if (!draftId) return
        try {
            const s = await getDraftState(draftId)
            setState(s)
            if (s?.openNomination?.countdownExpiresAt) {
                const diff = Math.max(
                    0,
                    Math.floor(
                        (new Date(s.openNomination.countdownExpiresAt).getTime() - Date.now()) /
                            1000,
                    ),
                )
                setBidAmount(Math.max((s.openNomination.currentBidAmount ?? 1) + 1, 2))
                setTimeLeft(diff)
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
        if (!state?.openNomination) return

        timerRef.current = setInterval(() => {
            const exp = state.openNomination?.countdownExpiresAt
            if (!exp) return
            const diff = Math.max(0, Math.floor((new Date(exp).getTime() - Date.now()) / 1000))
            setTimeLeft(diff)
        }, 500)

        return () => {
            if (timerRef.current) clearInterval(timerRef.current)
        }
    }, [state?.openNomination?.id, state?.openNomination?.countdownExpiresAt])

    // Player search
    useEffect(() => {
        if (!searchQuery.trim() || !draftId) {
            setSearchResults([])
            return
        }
        const timeout = setTimeout(async () => {
            setSearchLoading(true)
            try {
                const results = await searchPlayers(searchQuery, draftId)
                setSearchResults(results)
            } finally {
                setSearchLoading(false)
            }
        }, 300)
        return () => clearTimeout(timeout)
    }, [searchQuery, draftId])

    async function handleBid() {
        if (!state?.openNomination || !myMemberId || !draftId) return
        setBidding(true)
        try {
            await placeBid(draftId, myMemberId, state.openNomination.id, bidAmount)
            load()
        } catch (e: any) {
            Alert.alert('Bid failed', e.message)
        } finally {
            setBidding(false)
        }
    }

    async function handleNominate(playerId: string, playerName: string) {
        if (!myMemberId || !draftId) return
        setSubmittingNom(true)
        try {
            await nominatePlayer(draftId, myMemberId, playerId)
            setNominating(false)
            setSearchQuery('')
            setSearchResults([])
            load()
        } catch (e: any) {
            Alert.alert('Nomination failed', e.message)
        } finally {
            setSubmittingNom(false)
        }
    }

    if (loading || !state) {
        return <LoadingScreen />
    }

    const { draft, order, budgets, openNomination, currentNominatorMemberId, nominations } = state
    const isMyTurn = currentNominatorMemberId === myMemberId
    const currentNominatorTeam =
        order.find((o) => o.memberId === currentNominatorMemberId)?.teamName ?? 'Unknown'

    const myBudget = budgets.find((b) => b.memberId === myMemberId)
    const iAmLeading = openNomination?.currentBidderId === myMemberId
    const leadingTeam = budgets.find(
        (b) => b.memberId === openNomination?.currentBidderId,
    )?.teamName
    const closedNominations = nominations.filter((n) => n.status !== 'open').reverse()

    const iAmBankrupt = (myBudget?.remaining ?? 0) < 1
    // Min bid is current + 1, floored at 1
    const minBid = Math.max(1, (openNomination?.currentBidAmount ?? 0) + 1)

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
                    <Pressable style={styles.nominateButton} onPress={() => back()}>
                        <Text style={styles.nominateButtonText}>Back to League</Text>
                    </Pressable>
                </View>
            </SafeAreaView>
        )
    }

    return (
        <SafeAreaView style={styles.container} edges={['bottom']}>
            {/* Header */}
            <View style={styles.header}>
                <Text style={styles.headerTitle}>Auction Draft</Text>
                {myBudget && (
                    <View style={styles.budgetChip}>
                        <Text style={styles.budgetChipText}>${myBudget.remaining} left</Text>
                    </View>
                )}
            </View>

            <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
                {/* Nomination on the clock */}
                {openNomination ? (
                    <View style={styles.card}>
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
                                <Pressable
                                    style={styles.bidStep}
                                    onPress={() => setBidAmount((v) => Math.max(minBid, v - 1))}
                                >
                                    <Text style={styles.bidStepText}>−</Text>
                                </Pressable>
                                <TextInput
                                    style={styles.bidAmountInput}
                                    value={String(bidAmount)}
                                    onChangeText={(v) => {
                                        const n = parseInt(v, 10)
                                        if (!isNaN(n)) setBidAmount(n)
                                        else if (v === '') setBidAmount(minBid)
                                    }}
                                    onBlur={() =>
                                        setBidAmount((v) =>
                                            Math.min(
                                                myBudget?.remaining ?? 999,
                                                Math.max(minBid, v),
                                            ),
                                        )
                                    }
                                    keyboardType="number-pad"
                                    selectTextOnFocus
                                />
                                <Pressable
                                    style={styles.bidStep}
                                    onPress={() =>
                                        setBidAmount((v) =>
                                            Math.min(myBudget?.remaining ?? 999, v + 1),
                                        )
                                    }
                                >
                                    <Text style={styles.bidStepText}>+</Text>
                                </Pressable>
                                <Pressable
                                    style={[styles.bidButton, bidding && styles.bidButtonDisabled]}
                                    onPress={handleBid}
                                    disabled={
                                        bidding ||
                                        bidAmount <= openNomination.currentBidAmount ||
                                        iAmLeading ||
                                        timeLeft === 0
                                    }
                                >
                                    {bidding ? (
                                        <ActivityIndicator size="small" color={colors.textWhite} />
                                    ) : (
                                        <Text style={styles.bidButtonText}>Bid ${bidAmount.toLocaleString()}</Text>
                                    )}
                                </Pressable>
                            </View>
                        )}
                    </View>
                ) : (
                    /* No open nomination — show whose turn it is */
                    <View style={styles.card}>
                        {isMyTurn ? (
                            <>
                                <Text style={styles.yourTurnBanner}>Your turn to nominate!</Text>
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
                                                    <Pressable
                                                        style={styles.playerResult}
                                                        onPress={() =>
                                                            handleNominate(
                                                                item.id,
                                                                item.display_name,
                                                            )
                                                        }
                                                        disabled={submittingNom}
                                                    >
                                                        <View style={styles.flex1}>
                                                            <Text style={styles.playerResultName}>
                                                                {item.display_name}
                                                            </Text>
                                                            <Text style={styles.playerResultMeta}>
                                                                {item.nba_team ?? '—'} ·{' '}
                                                                {item.position ?? '—'}
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
                                                    </Pressable>
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
                                        <Pressable
                                            style={styles.cancelNomButton}
                                            onPress={() => {
                                                setNominating(false)
                                                setSearchQuery('')
                                                setSearchResults([])
                                            }}
                                        >
                                            <Text style={styles.cancelNomText}>Cancel</Text>
                                        </Pressable>
                                    </>
                                ) : (
                                    <Pressable
                                        style={styles.nominateButton}
                                        onPress={() => setNominating(true)}
                                    >
                                        <Text style={styles.nominateButtonText}>
                                            Search & Nominate a Player
                                        </Text>
                                    </Pressable>
                                )}
                            </>
                        ) : (
                            <View style={styles.waitingRow}>
                                <Text style={styles.waitingText}>Waiting for</Text>
                                <Text style={styles.waitingTeam}>{currentNominatorTeam}</Text>
                                <Text style={styles.waitingText}>to nominate...</Text>
                            </View>
                        )}
                    </View>
                )}

                {/* Tab switcher */}
                <View style={styles.tabRow}>
                    {(['budgets', 'history'] as DraftTab[]).map((t) => (
                        <Pressable
                            key={t}
                            style={[styles.tabChip, tab === t && styles.tabChipActive]}
                            onPress={() => setTab(t)}
                        >
                            <Text
                                style={[styles.tabChipText, tab === t && styles.tabChipTextActive]}
                            >
                                {t === 'budgets'
                                    ? 'Budgets'
                                    : `History (${closedNominations.length})`}
                            </Text>
                        </Pressable>
                    ))}
                </View>

                {tab === 'budgets' ? (
                    <View style={styles.card}>
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
                    </View>
                ) : closedNominations.length === 0 ? (
                    <View style={styles.empty}>
                        <Text style={styles.emptyText}>No players sold yet.</Text>
                    </View>
                ) : (
                    <View style={styles.card}>
                        {closedNominations.map((n, i) => {
                            const winnerTeam = budgets.find(
                                (b) => b.memberId === n.winningMemberId,
                            )?.teamName
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
                    </View>
                )}
            </ScrollView>
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgSubtle },
    flex1: { flex: 1 },
    scroll: { flex: 1 },
    scrollContent: { padding: spacing.xl, gap: spacing.lg },

    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.xl,
        paddingVertical: 14,
        backgroundColor: colors.bgScreen,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
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
    bidAmount: { fontSize: fontSize['3xl'], fontWeight: fontWeight.extrabold, color: colors.primary },
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

    yourTurnBanner: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: colors.primary, textAlign: 'center' },
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
    nominateLabel: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primary },
    emptySearch: { fontSize: fontSize.sm, color: colors.textPlaceholder, textAlign: 'center', marginTop: spacing.md },
    cancelNomButton: { marginTop: spacing.md, alignItems: 'center' },
    cancelNomText: { fontSize: fontSize.md, color: colors.textMuted, fontWeight: fontWeight.semibold },

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
    meAccent: { color: colors.primary },

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

import {
    View,
    Text,
    TextInput,
    StyleSheet,
    ScrollView,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    useWindowDimensions,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import {
    getDraftState,
    subscribeToDraft,
    unsubscribeFromDraft,
    nominatePlayer,
    placeBid,
    withdrawNomination,
    stopDraft,
    resetDraft,
    pauseDraft,
    resumeDraft,
    searchPlayers,
    DraftState,
    DraftSearchPlayer,
    NominationOrderMode,
    NOMINATION_ORDER_MODE_LABELS,
} from '@/lib/draft'
import { RealtimeChannel } from '@supabase/supabase-js'
import { alpha, colors, fontFamily, fontSize, fontWeight, palette, radii, spacing } from '@/constants/tokens'
import { showAlert, confirmAction, getErrorMessage } from '@/lib/alert'
import { MotionPressable, MotionView } from '@/components/Motion'

type DraftTab = 'budgets' | 'history'

function ageLabel(age: number | null | undefined): string | null {
    if (age == null || !Number.isFinite(age)) return null
    return `Age ${Number(age).toFixed(1)}`
}

function playerMeta(parts: (string | null | undefined)[]): string {
    return parts.filter(Boolean).join(' · ') || '—'
}

export default function DraftRoomScreen() {
    const { draftId } = useLocalSearchParams<{ draftId: string }>()
    const { current, isCommissioner } = useLeagueContext()
    const router = useRouter()
    const { width, height } = useWindowDimensions()
    const compactLandscape = width >= 600 && height < 500

    const [state, setState] = useState<DraftState | null>(null)
    const [tab, setTab] = useState<DraftTab>('budgets')
    const [loadError, setLoadError] = useState<string | null>(null)

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
    const [searchError, setSearchError] = useState<string | null>(null)
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
            setLoadError(null)
            // Only commit a DEFINITE state. getDraftState() returns null (not a
            // throw) on a transient fetch failure; committing null would blank the
            // whole live auction room for seconds during bidding,
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
            if (seq === loadSeqRef.current) setLoadError(getErrorMessage(e))
        }
    }, [draftId])

    const handleStopDraft = useCallback(() => {
        if (!draftId) return
        confirmAction(
            'Stop draft?',
            'This ends the draft now. Players already drafted stay on their rosters and the league moves into the season. This cannot be undone.',
            () => {
                void (async () => {
                    try {
                        await stopDraft(draftId)
                        router.replace(state?.draft.isMock ? '/league?tab=mockRooms' : '/league?tab=auctions')
                    } catch (e) {
                        showAlert('Could not stop draft', getErrorMessage(e))
                    }
                })()
            },
            'Stop Draft',
        )
    }, [draftId, router, state?.draft.isMock])

    const handleResetDraft = useCallback(() => {
        if (!draftId) return
        confirmAction(
            'Reset draft?',
            'This wipes every pick, bid, and budget and restarts the draft from scratch. This cannot be undone.',
            () => {
                void (async () => {
                    try {
                        await resetDraft(draftId)
                        await load()
                    } catch (e) {
                        showAlert('Could not reset draft', getErrorMessage(e))
                    }
                })()
            },
            'Reset Draft',
        )
    }, [draftId, load])

    const handlePauseDraft = useCallback(() => {
        if (!draftId) return
        confirmAction(
            'Pause draft?',
            'This freezes nominations and bidding until the commissioner resumes the draft.',
            () => {
                void (async () => {
                    try {
                        await pauseDraft(draftId)
                        await load()
                    } catch (e) {
                        showAlert('Could not pause draft', getErrorMessage(e))
                    }
                })()
            },
            'Pause Draft',
        )
    }, [draftId, load])

    const handleResumeDraft = useCallback(() => {
        if (!draftId) return
        confirmAction(
            'Resume draft?',
            'This reopens the draft clock and lets managers nominate and bid again.',
            () => {
                void (async () => {
                    try {
                        await resumeDraft(draftId)
                        await load()
                    } catch (e) {
                        showAlert('Could not resume draft', getErrorMessage(e))
                    }
                })()
            },
            'Resume Draft',
        )
    }, [draftId, load])

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
            setSearchError(null)
            try {
                const results = await searchPlayers(searchQuery, draftId, nominationModeRef.current)
                setSearchResults(results)
            } catch (e) {
                setSearchResults([])
                setSearchError(getErrorMessage(e))
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
    const wonCountByMember = useMemo(() => {
        const counts = new Map<string, number>()
        for (const n of closedNominations) {
            if (n.status !== 'sold' || !n.winningMemberId) continue
            counts.set(n.winningMemberId, (counts.get(n.winningMemberId) ?? 0) + 1)
        }
        return counts
    }, [closedNominations])

    function navigateBackToDraftList(isMock = false) {
        router.replace(isMock ? '/league?tab=mockRooms' : '/league?tab=auctions')
    }

    function renderScreenHeader(title: string, isMock = false, budgetRemaining?: number) {
        return (
            <View style={styles.screenHeader}>
                <Pressable
                    onPress={() => navigateBackToDraftList(isMock)}
                    style={styles.headerBack}
                    role="link"
                    aria-label="Back to league drafts"
                    accessibilityRole="link"
                    accessibilityLabel="Back to league drafts"
                >
                    <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
                </Pressable>
                <Text style={styles.screenTitle} numberOfLines={1}>
                    {title}
                </Text>
                {budgetRemaining != null ? (
                    <View style={styles.budgetChip}>
                        <Text style={styles.budgetChipText}>${budgetRemaining} left</Text>
                    </View>
                ) : null}
            </View>
        )
    }

    if (!state) {
        const hasLoadError = loadError != null
        return (
            <>
                <Stack.Screen options={{ title: 'Draft Room', headerShown: false }} />
                <SafeAreaView style={styles.container} edges={['bottom']}>
                    {renderScreenHeader('Auction Draft')}
                    <View style={styles.draftEndedContainer}>
                        <Text style={styles.draftEndedTitle}>{hasLoadError ? 'Could not load draft' : 'Draft not found'}</Text>
                        <Text style={styles.draftEndedSub}>
                            {hasLoadError ? loadError : 'This draft may have ended or no longer exists.'}
                        </Text>
                        <MotionPressable
                            style={styles.nominateButton}
                            onPress={hasLoadError ? load : () => navigateBackToDraftList()}
                            pressedScale={0.96}
                        >
                            <Text style={styles.nominateButtonText}>{hasLoadError ? 'Try Again' : 'Back to League'}</Text>
                        </MotionPressable>
                    </View>
                </SafeAreaView>
            </>
        )
    }

    const { draft, order, budgets, openNomination, currentNominatorMemberId } = state
    const isMyTurn = currentNominatorMemberId === myMemberId
    const isPaused = draft.status === 'paused'
    const currentNominatorTeam =
        order.find((o) => o.memberId === currentNominatorMemberId)?.teamName ?? 'Unknown'

    const myBudget = myMemberId ? budgetByMember.get(myMemberId) : undefined
    const iAmLeading = openNomination?.currentBidderId === myMemberId
    const leadingTeam = openNomination?.currentBidderId
        ? budgetByMember.get(openNomination.currentBidderId)?.teamName
        : undefined

    const iAmBankrupt = (myBudget?.remaining ?? 0) < 1
    // Hot final seconds — the clock and the nomination card shift to the danger
    // accent together so the whole block reads as "going once, going twice".
    const clockUrgent = !isPaused && openNomination != null && timeLeft <= 10
    // Min bid is current + 1, floored at 1
    const minBid = Math.max(1, (openNomination?.currentBidAmount ?? 0) + 1)
    const remainingBudget = myBudget?.remaining ?? Infinity
    const bidValue = parseInt(bidText, 10) // NaN while the field is empty/partial
    const bidValid = !isNaN(bidValue) && bidValue >= minBid && bidValue <= remainingBudget
    const draftTitle = draft.isMock ? 'Mock Auction Draft' : 'Auction Draft'

    if (draft.status === 'completed' || draft.status === 'cancelled') {
        const stopped = draft.status === 'cancelled'
        return (
            <>
                <Stack.Screen options={{ title: 'Draft Room', headerShown: false }} />
                <SafeAreaView style={styles.container} edges={['bottom']}>
                    {renderScreenHeader(draftTitle, draft.isMock)}
                    <View style={styles.draftEndedContainer}>
                        <Text style={styles.draftEndedTitle}>{stopped ? 'Draft Stopped' : 'Draft Complete'}</Text>
                        <Text style={styles.draftEndedSub}>
                            {stopped
                                ? 'The commissioner ended the draft. Players already drafted are on their rosters; everyone else is a free agent.'
                                : 'All teams are out of budget. Remaining players are free agents.'}
                        </Text>
                        <MotionPressable
                            style={styles.nominateButton}
                            onPress={() => navigateBackToDraftList(draft.isMock)}
                            pressedScale={0.96}
                        >
                            <Text style={styles.nominateButtonText}>Back to League</Text>
                        </MotionPressable>
                    </View>
                </SafeAreaView>
            </>
        )
    }

    return (
        <>
            <Stack.Screen options={{ title: 'Draft Room', headerShown: false }} />
            <SafeAreaView style={styles.container} edges={['bottom']}>
            {renderScreenHeader(draftTitle, draft.isMock, myBudget?.remaining)}

            {isCommissioner ? (
                <View style={styles.adminBar}>
                    <Text style={styles.adminBarLabel}>Commissioner</Text>
                    <View style={styles.adminBarBtns}>
                        <MotionPressable
                            style={[styles.adminBtn, styles.adminBtnPause]}
                            onPress={isPaused ? handleResumeDraft : handlePauseDraft}
                            pressedScale={0.94}
                            accessibilityRole="button"
                            accessibilityLabel={isPaused ? 'Resume draft' : 'Pause draft'}
                        >
                            <Text style={styles.adminBtnPauseText}>{isPaused ? 'Resume' : 'Pause'}</Text>
                        </MotionPressable>
                        <MotionPressable
                            style={[styles.adminBtn, styles.adminBtnReset]}
                            onPress={handleResetDraft}
                            pressedScale={0.94}
                            accessibilityRole="button"
                            accessibilityLabel="Reset draft"
                        >
                            <Text style={styles.adminBtnResetText}>Reset</Text>
                        </MotionPressable>
                        <MotionPressable
                            style={[styles.adminBtn, styles.adminBtnStop]}
                            onPress={handleStopDraft}
                            pressedScale={0.94}
                            accessibilityRole="button"
                            accessibilityLabel="Stop draft"
                        >
                            <Text style={styles.adminBtnStopText}>Stop</Text>
                        </MotionPressable>
                    </View>
                </View>
            ) : null}

            {loadError ? (
                <Pressable style={styles.refreshWarning} onPress={load}>
                    <Text style={styles.refreshWarningText}>Live draft refresh failed. Tap to retry.</Text>
                </Pressable>
            ) : null}

            <KeyboardAvoidingView
                style={styles.keyboard}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
            <ScrollView
                style={styles.scroll}
                contentContainerStyle={[styles.scrollContent, compactLandscape && styles.scrollContentCompact]}
                keyboardShouldPersistTaps="handled"
            >
                {/* Nomination on the clock */}
                {openNomination ? (
                    <View style={[styles.card, compactLandscape && styles.cardCompact, clockUrgent && styles.cardUrgent]}>
                        <View style={[styles.liveAuctionLayout, compactLandscape && styles.liveAuctionLayoutCompact]}>
                            <View style={styles.livePlayerInfo}>
                                <Text style={styles.cardLabel}>ON THE BLOCK</Text>
                                <Text style={styles.playerName} numberOfLines={compactLandscape ? 2 : undefined}>
                                    {openNomination.player?.displayName ?? 'Unknown Player'}
                                </Text>
                                <Text style={styles.playerMeta} numberOfLines={compactLandscape ? 1 : undefined}>
                                    {playerMeta([
                                        openNomination.player?.nbaTeam,
                                        openNomination.player?.position,
                                        ageLabel(openNomination.player?.age),
                                    ])}
                                </Text>
                            </View>

                            <View style={[styles.liveBidPanel, compactLandscape && styles.liveBidPanelCompact]}>
                                <View style={[styles.bidRow, compactLandscape && styles.bidRowCompact]}>
                                    <View style={styles.bidInfo}>
                                        <Text style={[styles.bidAmount, iAmLeading && styles.bidAmountLeading]}>
                                            {openNomination.currentBidAmount > 0
                                                ? `$${openNomination.currentBidAmount}`
                                                : '—'}
                                        </Text>
                                        <Text style={[styles.bidLeader, iAmLeading && styles.bidLeaderLeading]}>
                                            {openNomination.currentBidderId == null
                                                ? 'No bids yet'
                                                : iAmLeading
                                                  ? "You're leading"
                                                  : `${leadingTeam} leads`}
                                        </Text>
                                    </View>
                                    <View style={[styles.countdown, clockUrgent && styles.countdownUrgent]}>
                                        <Text
                                            style={[
                                                styles.countdownText,
                                                isPaused && styles.countdownTextPaused,
                                                clockUrgent && styles.countdownTextUrgent,
                                            ]}
                                        >
                                            {isPaused ? 'Paused' : `0:${String(timeLeft).padStart(2, '0')}`}
                                        </Text>
                                    </View>
                                </View>

                                {!iAmLeading && !iAmBankrupt && !isPaused && (
                                    <View style={[styles.bidInputRow, compactLandscape && styles.bidInputRowCompact]}>
                                        {/* Non-wrapping group: the row may wrap between this
                                            group and the Bid button, never inside −/amount/+. */}
                                        <View style={styles.bidStepGroup}>
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
                                                style={[styles.bidAmountInput, compactLandscape && styles.bidAmountInputCompact]}
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
                                        </View>
                                        <MotionPressable
                                            style={[
                                                styles.bidButton,
                                                compactLandscape && styles.bidButtonCompact,
                                                (bidding || !bidValid) && styles.bidButtonDisabled,
                                            ]}
                                            onPress={handleBid}
                                            accessibilityRole="button"
                                            accessibilityLabel={`Bid $${(bidValid ? bidValue : minBid).toLocaleString()}`}
                                            disabled={bidding || !bidValid || iAmLeading || timeLeft === 0}
                                            pressedScale={0.965}
                                        >
                                            <Text style={styles.bidButtonText}>
                                                Bid ${(bidValid ? bidValue : minBid).toLocaleString()}
                                            </Text>
                                        </MotionPressable>
                                    </View>
                                )}
                            </View>
                        </View>

                        {openNomination.nominatingMemberId === myMemberId &&
                            !isPaused &&
                            openNomination.currentBidderId == null && (
                                <MotionPressable
                                    style={styles.withdrawButton}
                                    onPress={handleWithdraw}
                                    disabled={withdrawing}
                                    accessibilityRole="button"
                                    accessibilityLabel="Withdraw nomination"
                                    pressedScale={0.96}
                                >
                                    <Text style={styles.withdrawButtonText}>Withdraw nomination</Text>
                                </MotionPressable>
                            )}
                    </View>
                ) : (
                    /* No open nomination — show whose turn it is */
                    <View style={[styles.card, compactLandscape && styles.cardCompact]}>
                        {isPaused ? (
                            <View style={styles.waitingRow}>
                                <Text style={styles.waitingTeam}>Draft paused</Text>
                                <Text style={styles.waitingText}>Commissioner will resume the clock.</Text>
                            </View>
                        ) : isMyTurn ? (
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
                                            accessibilityLabel="Search player name"
                                        />
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
                                                    accessibilityRole="button"
                                                    accessibilityLabel={`Nominate ${item.display_name ?? 'player'}`}
                                                >
                                                    <View style={styles.flex1}>
                                                        <Text style={styles.playerResultName}>
                                                            {item.display_name}
                                                        </Text>
                                                        <Text style={styles.playerResultMeta}>
                                                            {playerMeta([
                                                                item.dynasty_rank != null ? `#${item.dynasty_rank}` : null,
                                                                item.nba_team,
                                                                item.position,
                                                                ageLabel(item.age),
                                                            ])}
                                                        </Text>
                                                    </View>
                                                    <Text style={styles.nominateLabel}>
                                                        Nominate
                                                    </Text>
                                                </MotionPressable>
                                            )}
                                            ListEmptyComponent={
                                                searchError ? (
                                                    <Text style={styles.emptySearch}>
                                                        Search failed. Keep typing or try again.
                                                    </Text>
                                                ) : searchQuery.length > 0 && !searchLoading ? (
                                                    <Text style={styles.emptySearch}>
                                                        No players found
                                                    </Text>
                                                ) : null
                                            }
                                        />
                                        <MotionPressable
                                            style={styles.cancelNomButton}
                                            onPress={() => {
                                                setNominating(false)
                                                setSearchQuery('')
                                                setSearchResults([])
                                            }}
                                            pressedScale={0.94}
                                            accessibilityRole="button"
                                            accessibilityLabel="Cancel nomination search"
                                        >
                                            <Text style={styles.cancelNomText}>Cancel</Text>
                                        </MotionPressable>
                                    </>
                                ) : (
                                    <MotionPressable
                                        style={styles.nominateButton}
                                        onPress={() => setNominating(true)}
                                        pressedScale={0.965}
                                        accessibilityRole="button"
                                        accessibilityLabel="Search and nominate a player"
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
                    </View>
                )}

                {/* Live ticker — the last few hammer results, so the room feels
                    like an auction floor. Honest data only: these are real
                    closed nominations from state (per-bid history isn't held
                    client-side). */}
                {closedNominations.length > 0 ? (
                    <View style={styles.activityStrip}>
                        <Text style={styles.activityLabel}>Recent activity</Text>
                        <View style={styles.activityItems}>
                            {closedNominations.slice(0, 3).map((n) => {
                                const winnerTeam = n.winningMemberId
                                    ? budgetByMember.get(n.winningMemberId)?.teamName
                                    : undefined
                                return (
                                    <View key={n.id} style={styles.activityItem}>
                                        <Text style={styles.activityText} numberOfLines={1}>
                                            {n.status === 'sold'
                                                ? `${winnerTeam ?? 'Unknown'} won ${n.player?.displayName ?? 'Unknown'}`
                                                : n.status === 'withdrawn'
                                                  ? `${n.player?.displayName ?? 'Unknown'} withdrawn`
                                                  : `${n.player?.displayName ?? 'Unknown'} went unsold`}
                                        </Text>
                                        {n.status === 'sold' ? (
                                            <Text style={styles.activityPrice}>${n.finalPrice}</Text>
                                        ) : null}
                                    </View>
                                )
                            })}
                        </View>
                    </View>
                ) : null}

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
                    <MotionView style={[styles.card, compactLandscape && styles.cardCompact]} preset="rise" delay={80}>
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
                                    <Text style={styles.budgetWon}>
                                        {wonCountByMember.get(b.memberId) ?? 0} won
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
                    <MotionView style={[styles.card, compactLandscape && styles.cardCompact]} preset="rise" delay={80}>
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
                                            {playerMeta([
                                                n.status === 'sold' ? (winnerTeam ?? '—') : 'No bid',
                                                ageLabel(n.player?.age),
                                            ])}
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
        </>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgSubtle },
    flex1: { flex: 1 },
    keyboard: { flex: 1 },
    scroll: { flex: 1 },
    scrollContent: { padding: spacing.xl, paddingBottom: spacing['3xl'], gap: spacing.lg, width: '100%', maxWidth: 760, alignSelf: 'center' },
    scrollContentCompact: {
        paddingHorizontal: spacing.md,
        paddingTop: spacing.md,
        paddingBottom: spacing['4xl'],
        gap: spacing.sm,
    },

    screenHeader: {
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
        backgroundColor: colors.bgCard,
    },
    headerBack: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    screenTitle: {
        flex: 1,
        color: colors.textPrimary,
        fontSize: fontSize.lg,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.bold,
    },
    budgetChip: {
        backgroundColor: colors.primaryLight,
        minHeight: 36,
        justifyContent: 'center',
        paddingHorizontal: spacing.md,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
    },
    budgetChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
    adminBar: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.sm,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.sm,
        backgroundColor: colors.bgSubtle,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    adminBarLabel: {
        fontSize: 10,
        fontWeight: fontWeight.extrabold,
        letterSpacing: 0,
        textTransform: 'uppercase' as const,
        color: colors.textMuted,
    },
    adminBarBtns: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    adminBtn: {
        minHeight: 46,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: spacing.lg,
        borderRadius: radii.md,
        borderWidth: 1,
    },
    adminBtnReset: { backgroundColor: colors.bgCard, borderColor: colors.border },
    adminBtnPause: { backgroundColor: colors.primaryLight, borderColor: colors.primaryBorder },
    adminBtnStop: { backgroundColor: colors.dangerLight, borderColor: colors.danger },
    adminBtnResetText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textSecondary },
    adminBtnPauseText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
    adminBtnStopText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.dangerDark },
    refreshWarning: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.sm,
        backgroundColor: colors.dangerLight,
        borderBottomWidth: 1,
        borderBottomColor: colors.danger,
        alignItems: 'center',
    },
    refreshWarningText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.dangerDark },

    card: {
        backgroundColor: colors.bgScreen,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        padding: spacing.xl,
        gap: spacing.md,
    },
    cardCompact: {
        padding: spacing.md,
        gap: spacing.sm,
    },
    cardLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textPlaceholder, letterSpacing: 0 },

    playerName: { fontSize: 22, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    playerMeta: { fontSize: fontSize.sm, color: colors.textMuted },

    liveAuctionLayout: { gap: spacing.md },
    liveAuctionLayoutCompact: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: spacing.md,
    },
    livePlayerInfo: { flex: 1, minWidth: 0, gap: spacing.xs },
    liveBidPanel: { gap: spacing.md },
    liveBidPanelCompact: { width: 318, maxWidth: '100%', gap: spacing.sm },

    bidRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: spacing.xs,
    },
    bidRowCompact: { marginTop: 0 },
    bidInfo: { gap: spacing.xs },
    bidAmount: {
        fontSize: fontSize['4xl'],
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.bold,
        color: colors.primaryDark,
        letterSpacing: -0.5,
    },
    bidAmountLeading: { color: colors.successDark },
    bidLeader: { fontSize: fontSize.sm, color: colors.textMuted },
    bidLeaderLeading: {
        color: colors.successDark,
        fontWeight: fontWeight.bold,
        backgroundColor: colors.successLight,
        paddingHorizontal: spacing.md,
        paddingVertical: 2,
        borderRadius: radii.full,
        overflow: 'hidden' as const,
        alignSelf: 'flex-start' as const,
    },

    countdown: {
        width: 60,
        height: 60,
        borderRadius: 30,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        justifyContent: 'center',
        alignItems: 'center',
    },
    countdownUrgent: {
        backgroundColor: colors.dangerLight,
        borderWidth: 2,
        borderColor: colors.danger,
    },
    countdownText: {
        fontSize: 18,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.bold,
        color: colors.textSecondary,
    },
    countdownTextPaused: { fontSize: fontSize.sm },
    countdownTextUrgent: { color: colors.dangerDark },
    cardUrgent: {
        borderColor: colors.danger,
        borderWidth: 1.5,
        boxShadow: `0 0 0 3px ${alpha(palette.red500, 0.14)}`,
    },

    activityStrip: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: spacing.md,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    activityLabel: {
        fontSize: 10,
        fontWeight: fontWeight.extrabold,
        letterSpacing: 0.6,
        textTransform: 'uppercase' as const,
        color: colors.textMuted,
    },
    activityItems: {
        flex: 1,
        minWidth: 200,
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: spacing.xl,
        rowGap: spacing.xxs,
    },
    activityItem: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.xs, maxWidth: '100%' },
    activityText: { fontSize: fontSize.sm, color: colors.textSecondary, flexShrink: 1 },
    activityPrice: {
        fontSize: fontSize.sm,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.bold,
        color: colors.primaryDark,
    },

    bidInputRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.md, marginTop: spacing.xs },
    // flexShrink 0 keeps the −/amount/+ trio intact; the Bid button (flex:1) wraps
    // to its own line at narrow widths instead of pushing "+" off the card edge.
    bidStepGroup: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexShrink: 0 },
    bidInputRowCompact: { gap: spacing.sm, marginTop: 0 },
    bidStep: {
        width: 44,
        height: 44,
        borderRadius: 22,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        justifyContent: 'center',
        alignItems: 'center',
    },
    bidStepText: { fontSize: 20, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    bidAmountInput: {
        fontSize: 18,
        fontWeight: fontWeight.extrabold,
        width: 84,
        height: 44,
        textAlign: 'center',
        backgroundColor: colors.bgMuted,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        paddingHorizontal: 10,
        paddingVertical: spacing.sm,
    },
    bidAmountInputCompact: { width: 70, minWidth: 70 },
    bidButton: {
        flex: 1,
        minWidth: 112,
        height: 44,
        backgroundColor: colors.primary,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
    },
    bidButtonCompact: { minWidth: 96 },
    bidButtonDisabled: { opacity: 0.5 },
    bidButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: 15 },

    yourTurnBanner: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: colors.primaryDark, textAlign: 'center' },
    nominationModeHint: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', marginTop: spacing.xs },
    nominateButton: {
        marginTop: spacing.xs,
        height: 48,
        backgroundColor: colors.primary,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
    },
    nominateButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: 15 },

    searchInput: {
        height: 44,
        backgroundColor: colors.bgMuted,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        paddingHorizontal: 14,
        fontSize: 15,
        marginTop: spacing.xs,
    },

    playerResult: {
        minHeight: 52,
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.sm,
        borderTopWidth: 1,
        borderTopColor: colors.separator,
        gap: spacing.md,
    },
    playerResultName: { fontSize: 15, fontWeight: fontWeight.semibold },
    playerResultMeta: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
    nominateLabel: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
    emptySearch: { fontSize: fontSize.sm, color: colors.textPlaceholder, textAlign: 'center', marginTop: spacing.md },
    cancelNomButton: { minHeight: 44, marginTop: spacing.sm, alignItems: 'center', justifyContent: 'center' },
    cancelNomText: { fontSize: fontSize.md, color: colors.textMuted, fontWeight: fontWeight.semibold },
    withdrawButton: {
        minHeight: 46,
        marginTop: spacing.md,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.sm,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.border,
    },
    withdrawButtonText: { fontSize: fontSize.md, color: colors.textMuted, fontWeight: fontWeight.semibold },

    waitingRow: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.md },
    waitingText: { fontSize: fontSize.md, color: colors.textMuted },
    waitingTeam: { fontSize: 18, fontWeight: fontWeight.extrabold, color: colors.textPrimary },

    tabRow: { flexDirection: 'row', gap: spacing.md },
    tabChip: {
        flex: 1,
        minHeight: 44,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 14,
        borderRadius: radii.md,
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
    budgetWon: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textMuted, marginRight: spacing.lg },
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

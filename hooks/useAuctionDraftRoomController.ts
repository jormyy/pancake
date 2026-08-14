import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    closeExpiredNominations,
    getDraftPollRevision,
    getDraftState,
    nominatePlayer,
    placeBid,
    searchPlayers,
    subscribeToDraft,
    unsubscribeFromDraft,
    withdrawNomination,
    type DraftSearchPlayer,
    type DraftState,
    type NominationOrderMode,
} from '@/lib/draft'
import { getErrorMessage, showAlert } from '@/lib/alert'
import {
    debounceRealtimeRefresh,
    reportRealtimeCleanup,
    type RealtimeSubscriptionStatus,
} from '@/lib/realtime'

export type DraftTab = 'budgets' | 'history'

export function useAuctionDraftRoomController({
    draftId,
    memberId,
}: {
    draftId?: string
    memberId?: string
}) {
    const [state, setState] = useState<DraftState | null>(null)
    const [stateDraftId, setStateDraftId] = useState(draftId)
    const [tab, setTab] = useState<DraftTab>('budgets')
    const [loadError, setLoadError] = useState<string | null>(null)

    // Bidding — held as raw text so the field can be cleared/typed freely;
    // the value is validated and clamped only on submit (handleBid).
    const [bidText, setBidText] = useState('1')
    const [bidding, setBidding] = useState(false)
    const [withdrawing, setWithdrawing] = useState(false)

    const [realtimeStatus, setRealtimeStatus] =
        useState<RealtimeSubscriptionStatus | 'CONNECTING'>('CONNECTING')
    const activeDraftIdRef = useRef<string | undefined>(draftId)

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
    // Mirror of bidText so load() can read the current value without a dep.
    const bidTextRef = useRef('1')
    // Track which nomination has had its expiry close triggered so we only fire once per nomination.
    const closeTriggeredForNomRef = useRef<string | null>(null)
    // The draft's nomination-order mode is stable; keep it in a ref so the search
    // effect can read it without re-running on every poll-driven state change.
    const nominationModeRef = useRef<NominationOrderMode>('user_nominated')
    // Monotonic load token: realtime handlers + the 5s poll + post-action reloads
    // fire load() concurrently, so drop any result that a newer load supersedes.
    const loadSeqRef = useRef(0)
    const searchSeqRef = useRef(0)
    const pollRevisionRef = useRef<string | null>(null)
    const pollInFlightRef = useRef(false)

    // Keep bidTextRef in sync so load() can read current typed value without a dep.
    useEffect(() => { bidTextRef.current = bidText }, [bidText])

    const visibleState = stateDraftId === draftId ? state : null
    const countdownNomination = visibleState?.openNomination
    const draftLeagueId = visibleState?.draft.leagueId ?? null
    activeDraftIdRef.current = draftId

    useEffect(() => {
        loadSeqRef.current += 1
        searchSeqRef.current += 1
        setState(null)
        setStateDraftId(draftId)
        setLoadError(null)
        setBidText('1')
        setBidding(false)
        setWithdrawing(false)
        setNominating(false)
        setSearchQuery('')
        setSearchResults([])
        setSearchLoading(false)
        setSearchError(null)
        setSubmittingNom(false)
        setTimeLeft(0)
        setRealtimeStatus('CONNECTING')
        lastNomIdRef.current = null
        closeTriggeredForNomRef.current = null
        pollRevisionRef.current = null
        pollInFlightRef.current = false
        return () => {
            loadSeqRef.current += 1
            searchSeqRef.current += 1
        }
    }, [draftId])

    const load = useCallback(async () => {
        if (!draftId) return
        const requestedDraftId = draftId
        if (activeDraftIdRef.current !== requestedDraftId) return
        const seq = ++loadSeqRef.current
        try {
            const s = await getDraftState(requestedDraftId)
            // Ignore a stale, out-of-order result once a newer load has started.
            if (seq !== loadSeqRef.current || activeDraftIdRef.current !== requestedDraftId) return
            setLoadError(null)
            // Only commit a DEFINITE state. getDraftState() returns null (not a
            // throw) on a transient fetch failure; committing null would blank the
            // whole live auction room for seconds during bidding,
            // and would also reseed the bid field on the next good poll.
            if (s) {
                setStateDraftId(requestedDraftId)
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
                // Seed the bid field when a new player comes on the block, or when
                // the current bid has advanced past what the user typed (their value
                // would be invalid, so bring it up to the new minimum automatically).
                const nomId = nom?.id ?? null
                const minBid = (nom?.currentBidAmount ?? 0) + 1
                const typedValue = parseInt(bidTextRef.current, 10)
                const typedIsStale = isNaN(typedValue) || typedValue < minBid
                if (nomId !== lastNomIdRef.current || (nom && typedIsStale)) {
                    lastNomIdRef.current = nomId
                    if (nom) setBidText(String(minBid))
                }
            }
        } catch (e) {
            if (seq === loadSeqRef.current && activeDraftIdRef.current === requestedDraftId) {
                setLoadError(getErrorMessage(e))
            }
        }
    }, [draftId])

    // Load + subscribe. Mutations fail closed unless this channel is live.
    useEffect(() => {
        if (!draftId) return
        let active = true
        load()
        // A bidding war fires several inserts per second and every one of them
        // reloads the whole draft state; coalesce the burst into one reload.
        const refresh = debounceRealtimeRefresh(() => { void load() })
        const channel = subscribeToDraft(draftId, draftLeagueId, refresh.trigger, (status) => {
            if (active) setRealtimeStatus(status)
        })
        return () => {
            active = false
            refresh.cancel()
            reportRealtimeCleanup('auction draft', unsubscribeFromDraft(channel))
        }
    }, [draftId, draftLeagueId, load])

    // Realtime is primary. The fallback probes only current mutable rows and
    // reloads history/ages when their revision actually changes.
    useEffect(() => {
        if (!draftId) return
        const poll = setInterval(async () => {
            if (pollInFlightRef.current) return
            pollInFlightRef.current = true
            try {
                const revision = await getDraftPollRevision(draftId)
                if (activeDraftIdRef.current !== draftId) return
                if (pollRevisionRef.current === revision) return
                pollRevisionRef.current = revision
                await load()
            } catch (error) {
                if (activeDraftIdRef.current === draftId) {
                    console.error('Could not poll the live draft revision.', error)
                }
            } finally {
                pollInFlightRef.current = false
            }
        }, realtimeStatus === 'SUBSCRIBED' ? 60_000 : 5_000)
        return () => clearInterval(poll)
    }, [draftId, load, realtimeStatus])

    // Countdown tick
    useEffect(() => {
        if (timerRef.current) clearInterval(timerRef.current)
        if (!countdownNomination) return

        const computeDiff = () => {
            const exp = countdownNomination.countdownExpiresAt
            if (!exp) return
            const diff = Math.max(0, Math.floor((new Date(exp).getTime() - Date.now()) / 1000))
            setTimeLeft(diff)
            // When the clock hits zero, trigger server-side close once per nomination.
            if (diff === 0 && draftId && closeTriggeredForNomRef.current !== countdownNomination.id) {
                const requestedDraftId = draftId
                closeTriggeredForNomRef.current = countdownNomination.id
                closeExpiredNominations(requestedDraftId)
                    .then(({ closed }) => {
                        if (activeDraftIdRef.current !== requestedDraftId) return
                        // If the server closed nothing (clock skew — client hit 0 before
                        // the server expiry), reset so the next tick retries.
                        if (closed === 0) closeTriggeredForNomRef.current = null
                        else load()
                    })
                    .catch(() => {
                        if (activeDraftIdRef.current !== requestedDraftId) return
                        // Network/auth failure — reset so the next tick can retry.
                        closeTriggeredForNomRef.current = null
                    })
            }
        }
        // Seed immediately so a fresh nomination doesn't render the urgent
        // (<=10s) styling for the first 500ms while timeLeft is still 0.
        computeDiff()
        timerRef.current = setInterval(computeDiff, 500)

        return () => {
            if (timerRef.current) clearInterval(timerRef.current)
        }
    }, [countdownNomination, draftId, load])

    // Player search
    useEffect(() => {
        if (!nominating || !draftId) {
            searchSeqRef.current += 1
            setSearchResults([])
            setSearchLoading(false)
            return
        }
        const requestId = ++searchSeqRef.current
        const requestedQuery = searchQuery
        const requestedDraftId = draftId
        const requestedMode = nominationModeRef.current
        const timeout = setTimeout(async () => {
            setSearchLoading(true)
            setSearchError(null)
            try {
                const results = await searchPlayers(requestedQuery, requestedDraftId, requestedMode)
                if (searchSeqRef.current !== requestId) return
                setSearchResults(results)
            } catch (e) {
                if (searchSeqRef.current !== requestId) return
                setSearchResults([])
                setSearchError(getErrorMessage(e))
            } finally {
                if (searchSeqRef.current === requestId) setSearchLoading(false)
            }
        }, 300)
        return () => clearTimeout(timeout)
    }, [searchQuery, draftId, nominating])

    async function handleBid() {
        if (!visibleState?.openNomination || !memberId || !draftId) return
        if (!realtimeConnected) {
            showAlert('Live connection unavailable', 'Reconnect to the live draft before bidding.')
            return
        }
        const requestedDraftId = draftId
        // Guard the typed bid only at submit time: must be a whole-dollar amount
        // at least the minimum and within remaining budget.
        const min = Math.max(1, (visibleState.openNomination.currentBidAmount ?? 0) + 1)
        // Match bidValid's fallback; the RPC is the authoritative budget check.
        const remaining = visibleState.budgets.find((b) => b.memberId === memberId)?.remaining ?? Infinity
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
            await placeBid(draftId, memberId, visibleState.openNomination.id, amount)
            if (activeDraftIdRef.current !== requestedDraftId) return
            load()
        } catch (e) {
            if (activeDraftIdRef.current === requestedDraftId) showAlert('Bid failed', getErrorMessage(e))
        } finally {
            if (activeDraftIdRef.current === requestedDraftId) setBidding(false)
        }
    }

    async function handleWithdraw() {
        if (!visibleState?.openNomination || !memberId || !draftId) return
        const requestedDraftId = draftId
        setWithdrawing(true)
        try {
            await withdrawNomination(draftId, memberId, visibleState.openNomination.id)
            if (activeDraftIdRef.current !== requestedDraftId) return
            load()
        } catch (e) {
            if (activeDraftIdRef.current === requestedDraftId) showAlert('Could not withdraw', getErrorMessage(e))
        } finally {
            if (activeDraftIdRef.current === requestedDraftId) setWithdrawing(false)
        }
    }

    async function handleNominate(playerId: string) {
        if (!memberId || !draftId) return
        const requestedDraftId = draftId
        if (!realtimeConnected) {
            showAlert('Live connection unavailable', 'Reconnect to the live draft before nominating a player.')
            return
        }
        setSubmittingNom(true)
        try {
            await nominatePlayer(draftId, memberId, playerId)
            if (activeDraftIdRef.current !== requestedDraftId) return
            setNominating(false)
            setSearchQuery('')
            setSearchResults([])
            searchSeqRef.current += 1
            load()
        } catch (e) {
            if (activeDraftIdRef.current === requestedDraftId) showAlert('Nomination failed', getErrorMessage(e))
        } finally {
            if (activeDraftIdRef.current === requestedDraftId) setSubmittingNom(false)
        }
    }

    function cancelNominating() {
        setNominating(false)
        setSearchQuery('')
        setSearchResults([])
        searchSeqRef.current += 1
    }

    const realtimeConnected = realtimeStatus === 'SUBSCRIBED'

    // Memoize O(N) derivations from state so we don't recompute them every render
    // (poll fires every 5s; without memos every parent re-render rebuilds these arrays/maps).
    const closedNominations = useMemo(
        () =>
            visibleState
                ? visibleState.nominations.filter((n) => n.status !== 'open').reverse()
                : [],
        [visibleState],
    )
    const budgetByMember = useMemo(
        () => new Map((visibleState?.budgets ?? []).map((b) => [b.memberId, b])),
        [visibleState],
    )
    const wonCountByMember = useMemo(() => {
        const counts = new Map<string, number>()
        for (const n of closedNominations) {
            if (n.status !== 'sold' || !n.winningMemberId) continue
            counts.set(n.winningMemberId, (counts.get(n.winningMemberId) ?? 0) + 1)
        }
        return counts
    }, [closedNominations])

    return {
        state: visibleState,
        tab,
        setTab,
        loadError: loadError ?? (realtimeStatus !== 'SUBSCRIBED' && realtimeStatus !== 'CONNECTING'
            ? 'Live draft connection lost. Tap to retry.'
            : null),
        bidText,
        setBidText,
        bidding,
        withdrawing,
        nominating,
        setNominating,
        searchQuery,
        setSearchQuery,
        searchResults,
        searchLoading,
        searchError,
        submittingNom,
        timeLeft,
        closedNominations,
        budgetByMember,
        wonCountByMember,
        realtimeConnected,
        refresh: load,
        handleBid,
        handleWithdraw,
        handleNominate,
        cancelNominating,
    }
}

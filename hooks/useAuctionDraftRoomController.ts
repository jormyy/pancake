import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    closeExpiredNominations,
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
import type { RealtimeChannel } from '@supabase/supabase-js'
import { getErrorMessage, showAlert } from '@/lib/alert'

export type DraftTab = 'budgets' | 'history'

export function useAuctionDraftRoomController({
    draftId,
    memberId,
}: {
    draftId?: string
    memberId?: string
}) {
    const [state, setState] = useState<DraftState | null>(null)
    const [tab, setTab] = useState<DraftTab>('budgets')
    const [loadError, setLoadError] = useState<string | null>(null)

    // Bidding — held as raw text so the field can be cleared/typed freely;
    // the value is validated and clamped only on submit (handleBid).
    const [bidText, setBidText] = useState('1')
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

    // Keep bidTextRef in sync so load() can read current typed value without a dep.
    useEffect(() => { bidTextRef.current = bidText }, [bidText])

    const channelRef = useRef<RealtimeChannel | null>(null)
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
            if (seq === loadSeqRef.current) setLoadError(getErrorMessage(e))
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

        const computeDiff = () => {
            const exp = countdownNomination.countdownExpiresAt
            if (!exp) return
            const diff = Math.max(0, Math.floor((new Date(exp).getTime() - Date.now()) / 1000))
            setTimeLeft(diff)
            // When the clock hits zero, trigger server-side close once per nomination.
            if (diff === 0 && draftId && closeTriggeredForNomRef.current !== countdownNomination.id) {
                closeTriggeredForNomRef.current = countdownNomination.id
                closeExpiredNominations(draftId)
                    .then(({ closed }) => {
                        // If the server closed nothing (clock skew — client hit 0 before
                        // the server expiry), reset so the next tick retries.
                        if (closed === 0) closeTriggeredForNomRef.current = null
                        else load()
                    })
                    .catch(() => {
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
        if (!state?.openNomination || !memberId || !draftId) return
        // Guard the typed bid only at submit time: must be a whole-dollar amount
        // at least the minimum and within remaining budget.
        const min = Math.max(1, (state.openNomination.currentBidAmount ?? 0) + 1)
        // Match bidValid's fallback; the RPC is the authoritative budget check.
        const remaining = state.budgets.find((b) => b.memberId === memberId)?.remaining ?? Infinity
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
            await placeBid(draftId, memberId, state.openNomination.id, amount)
            load()
        } catch (e) {
            showAlert('Bid failed', getErrorMessage(e))
        } finally {
            setBidding(false)
        }
    }

    async function handleWithdraw() {
        if (!state?.openNomination || !memberId || !draftId) return
        setWithdrawing(true)
        try {
            await withdrawNomination(draftId, memberId, state.openNomination.id)
            load()
        } catch (e) {
            showAlert('Could not withdraw', getErrorMessage(e))
        } finally {
            setWithdrawing(false)
        }
    }

    async function handleNominate(playerId: string) {
        if (!memberId || !draftId) return
        setSubmittingNom(true)
        try {
            await nominatePlayer(draftId, memberId, playerId)
            setNominating(false)
            setSearchQuery('')
            setSearchResults([])
            searchSeqRef.current += 1
            load()
        } catch (e) {
            showAlert('Nomination failed', getErrorMessage(e))
        } finally {
            setSubmittingNom(false)
        }
    }

    function cancelNominating() {
        setNominating(false)
        setSearchQuery('')
        setSearchResults([])
        searchSeqRef.current += 1
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

    return {
        state,
        tab,
        setTab,
        loadError,
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
        refresh: load,
        handleBid,
        handleWithdraw,
        handleNominate,
        cancelNominating,
    }
}

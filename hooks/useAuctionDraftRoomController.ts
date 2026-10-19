import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDraftActivity } from '@/components/league/draft-room/useDraftActivity'
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
import { holdPwaUpdate } from '@/lib/pwa-update-guard'
import { showAlert } from '@/lib/alert'
import { getErrorMessage } from '@/lib/shared/errors'
import {
    reportRealtimeCleanup,
    type RealtimeSubscriptionStatus,
} from '@/lib/realtime'


/** Short enough for a live auction countdown; the rejoin reloads the room to catch up. */
const AUCTION_REJOIN_DELAY_MS = 3_000
export type DraftTab = 'budgets' | 'history'

export function useAuctionDraftRoomController({
    draftId,
    memberId,
}: {
    draftId?: string
    memberId?: string
}) {
    const activity = useDraftActivity(draftId && memberId ? `${draftId}:${memberId}` : null)
    const { identity, epoch, capture, canRead, isCurrent, canAct, markReady, blockActions } = activity
    const [state, setState] = useState<DraftState | null>(null)
    const snapshotRef = useRef<DraftState | null>(null)
    const [stateOwner, setStateOwner] = useState(identity)
    const activeIdentityRef = useRef(identity)
    activeIdentityRef.current = identity
    const [tab, setTab] = useState<DraftTab>('budgets')
    const [loadError, setLoadError] = useState<string | null>(null)

    // Bidding — held as raw text so the field can be cleared/typed freely;
    // the value is validated and clamped only on submit (handleBid).
    const [bidText, setBidText] = useState('1')
    const [bidToTaxi, setBidToTaxi] = useState(false)
    useEffect(() => { setBidToTaxi(false) }, [draftId, memberId])
    const [bidding, setBidding] = useState(false)
    const bidRequestRef = useRef<object | null>(null)
    const [withdrawing, setWithdrawing] = useState(false)

    const [realtimeStatus, setRealtimeStatus] =
        useState<RealtimeSubscriptionStatus | 'CONNECTING'>('CONNECTING')
    // A CLOSED channel never rejoins on its own; a new epoch builds a fresh subscription.
    const [subscriptionEpoch, setSubscriptionEpoch] = useState(0)
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
    const expiryAttemptRef = useRef<{
        key: string; attempts: number; nextAt: number; inFlight: boolean; completed: boolean
    } | null>(null)
    // The draft's nomination-order mode is stable; keep it in a ref so the search
    // effect can read it without re-running on every poll-driven state change.
    const nominationModeRef = useRef<NominationOrderMode>('user_nominated')
    // Monotonic load token: realtime handlers + the 5s poll + post-action reloads
    // fire load() concurrently, so drop any result that a newer load supersedes.
    const loadSeqRef = useRef(0)
    const searchSeqRef = useRef(0)
    const pendingRefreshRef = useRef(true)
    const inFlightRef = useRef<{ epoch: number; identity: string; promise: Promise<boolean> } | null>(null)
    const pollRevisionRef = useRef<string | null | undefined>(undefined)

    // Keep bidTextRef in sync so load() can read current typed value without a dep.
    useEffect(() => { bidTextRef.current = bidText }, [bidText])

    const visibleState = stateOwner === identity ? state : null
    const countdownNomination = visibleState?.draft.status === 'in_progress' ? visibleState.openNomination : null
    activeDraftIdRef.current = draftId

    useEffect(() => draftId ? holdPwaUpdate('auction room') : undefined, [draftId])

    useEffect(() => {
        snapshotRef.current = null
        loadSeqRef.current += 1
        searchSeqRef.current += 1
        setState(null)
        setStateOwner(identity)
        setLoadError(null)
        setBidText('1')
        bidRequestRef.current = null
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
        expiryAttemptRef.current = null
        pollRevisionRef.current = undefined
        return () => {
            loadSeqRef.current += 1
            searchSeqRef.current += 1
        }
    }, [draftId, identity])

    const load = useCallback(async (incremental = false) => {
        if (!draftId) return false
        pendingRefreshRef.current = true
        if (!canRead()) return false
        const readEpoch = capture()
        if (inFlightRef.current?.identity === identity && inFlightRef.current.epoch === readEpoch) return inFlightRef.current.promise
        pendingRefreshRef.current = false
        const requestedDraftId = draftId
        if (activeDraftIdRef.current !== requestedDraftId) return false
        const seq = ++loadSeqRef.current
        const task = (async () => {
            try {
                const s = incremental && canAct()
                    ? await getDraftState(requestedDraftId, snapshotRef.current)
                    : await getDraftState(requestedDraftId)
                // Ignore a stale, out-of-order result once a newer load has started.
                if (!isCurrent(readEpoch) || seq !== loadSeqRef.current || activeDraftIdRef.current !== requestedDraftId) return false
                snapshotRef.current = s
                setLoadError(null)
                // A successful empty read means the room is gone. Read failures throw
                // and keep the last usable state in the catch path below.
                if (s) {
                    setStateOwner(identity)
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
                } else {
                    setStateOwner(identity)
                    setState(null)
                    setTimeLeft(0)
                    setNominating(false)
                    lastNomIdRef.current = null
                    expiryAttemptRef.current = null
                }
                markReady(readEpoch)
                return true
            } catch (e) {
                if (isCurrent(readEpoch) && seq === loadSeqRef.current && activeDraftIdRef.current === requestedDraftId) {
                    pendingRefreshRef.current = true
                    setLoadError(getErrorMessage(e))
                }
                return false
            }
        })()
        const request = { epoch: readEpoch, identity, promise: task }
        inFlightRef.current = request
        try { return await task }
        finally { if (inFlightRef.current === request) inFlightRef.current = null }
    }, [draftId, identity, capture, canRead, isCurrent, canAct, markReady])

    useEffect(() => {
        searchSeqRef.current += 1
        if (!canRead()) {
            pendingRefreshRef.current = true
            loadSeqRef.current += 1
        } else if (!canAct() || pendingRefreshRef.current) void load()
    }, [epoch, canRead, canAct, load])

    // Load + subscribe. Mutations fail closed unless this channel is live.
    useEffect(() => {
        if (!draftId) return
        let active = true
        if (subscriptionEpoch > 0) void load()
        // A bidding war fires several inserts per second and every one of them
        // reloads the whole draft state; coalesce the burst into one reload.
        let refreshTimer: ReturnType<typeof setTimeout> | null = null
        let refreshing = false
        let pending = false
        const refresh = {
            trigger: () => {
                if (!active) return
                pending = true
                pendingRefreshRef.current = true
                if (!canRead()) return
                if (refreshing || refreshTimer) return
                refreshTimer = setTimeout(async () => {
                    refreshTimer = null
                    refreshing = true
                    pending = false
                    try { await load(true) }
                    finally {
                        refreshing = false
                        if (pending && active) refresh.trigger()
                    }
                }, 250)
            },
            cancel: () => {
                if (refreshTimer) clearTimeout(refreshTimer)
                refreshTimer = null
                pending = false
            },
        }
        let rejoin: ReturnType<typeof setTimeout> | null = null
        const channel = subscribeToDraft(draftId, null, refresh.trigger, (status) => {
            if (!active) return
            if (status !== 'SUBSCRIBED') blockActions()
            setRealtimeStatus(status)
            // CHANNEL_ERROR and TIMED_OUT rejoin inside the client; CLOSED is terminal, so subscribe again.
            if (status === 'CLOSED' && !rejoin) {
                rejoin = setTimeout(() => {
                    rejoin = null
                    if (!active) return
                    setRealtimeStatus('CONNECTING')
                    setSubscriptionEpoch((epoch) => epoch + 1)
                }, AUCTION_REJOIN_DELAY_MS)
            }
        }, load)
        return () => {
            active = false
            if (rejoin) clearTimeout(rejoin)
            refresh.cancel()
            reportRealtimeCleanup('auction draft', unsubscribeFromDraft(channel))
        }
    }, [draftId, load, subscriptionEpoch, canRead, blockActions])

    // Realtime is primary. The fallback probes only current mutable rows and
    // reloads history/ages when their revision actually changes.
    useEffect(() => {
        if (!draftId) return
        let active = true
        let inFlight = false
        const pollRevision = async () => {
            if (!active || !canRead() || inFlight) return
            if (pendingRefreshRef.current) { await load(); return }
            inFlight = true
            const readEpoch = capture()
            try {
                const revision = await getDraftPollRevision(draftId)
                if (!active || !isCurrent(readEpoch) || activeDraftIdRef.current !== draftId) return
                if (pollRevisionRef.current === revision) return
                const loaded = await load()
                if (loaded && active && isCurrent(readEpoch)) pollRevisionRef.current = revision
            } catch (error) {
                if (active && isCurrent(readEpoch)) console.error('Could not poll the live draft revision.', error)
            } finally {
                inFlight = false
            }
        }
        const poll = setInterval(() => { void pollRevision() }, realtimeStatus === 'SUBSCRIBED' ? 60_000 : 5_000)
        return () => {
            active = false
            clearInterval(poll)
        }
    }, [draftId, load, realtimeStatus, canRead, capture, isCurrent])

    // Countdown tick
    useEffect(() => {
        if (timerRef.current) clearInterval(timerRef.current)
        if (!countdownNomination) return

        const computeDiff = () => {
            const exp = countdownNomination.countdownExpiresAt
            if (!exp) return
            const diff = Math.max(0, Math.floor((new Date(exp).getTime() - Date.now()) / 1000))
            setTimeLeft(diff)
            if (diff !== 0 || Date.now() < new Date(exp).getTime() + 1_000 || !draftId || !canAct()) return
            const key = `${draftId}:${countdownNomination.id}:${exp}`
            if (expiryAttemptRef.current?.key !== key) {
                expiryAttemptRef.current = { key, attempts: 0, nextAt: 0, inFlight: false, completed: false }
            }
            const attempt = expiryAttemptRef.current
            if (attempt.completed || attempt.inFlight || attempt.attempts >= 5 || Date.now() < attempt.nextAt) return
            const requestedDraftId = draftId
            attempt.inFlight = true
            attempt.attempts += 1
            attempt.nextAt = Date.now() + [2_000, 5_000, 10_000, 30_000, 30_000][attempt.attempts - 1]
            void closeExpiredNominations(requestedDraftId)
                .then(async ({ closed }) => {
                    if (activeDraftIdRef.current !== requestedDraftId || expiryAttemptRef.current !== attempt) return
                    if (closed > 0) {
                        attempt.completed = true
                        await load()
                    }
                })
                .catch(() => undefined)
                .finally(() => { attempt.inFlight = false })
        }
        // Seed immediately so a fresh nomination doesn't render the urgent
        // (<=10s) styling for the first 500ms while timeLeft is still 0.
        computeDiff()
        timerRef.current = setInterval(computeDiff, 500)

        return () => {
            if (timerRef.current) clearInterval(timerRef.current)
        }
    }, [countdownNomination, draftId, load, canAct])

    // Player search
    useEffect(() => {
        if (!nominating || !draftId) {
            searchSeqRef.current += 1
            setSearchResults([])
            setSearchLoading(false)
            return
        }
        if (!canAct()) return
        const readEpoch = capture()
        const requestId = ++searchSeqRef.current
        const requestedQuery = searchQuery
        const requestedDraftId = draftId
        const requestedMode = nominationModeRef.current
        const timeout = setTimeout(async () => {
            if (!isCurrent(readEpoch) || !canAct()) return
            setSearchLoading(true)
            setSearchError(null)
            try {
                const results = await searchPlayers(requestedQuery, requestedDraftId, requestedMode)
                if (!isCurrent(readEpoch) || searchSeqRef.current !== requestId) return
                setSearchResults(results)
            } catch (e) {
                if (!isCurrent(readEpoch) || searchSeqRef.current !== requestId) return
                setSearchResults([])
                setSearchError(getErrorMessage(e))
            } finally {
                if (isCurrent(readEpoch) && searchSeqRef.current === requestId) setSearchLoading(false)
            }
        }, 300)
        return () => clearTimeout(timeout)
    }, [searchQuery, draftId, nominating, activity.ready, epoch, canAct, capture, isCurrent])

    async function handleBid() {
        if (!canAct() || bidRequestRef.current) return
        if (!visibleState?.openNomination || !memberId || !draftId) return
        if (!realtimeConnected) {
            showAlert('Live connection unavailable', 'Reconnect to the live draft before bidding.')
            return
        }
        const requestedDraftId = draftId
        const actionEpoch = capture()
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
        const request = {}
        bidRequestRef.current = request
        setBidding(true)
        try {
            await placeBid(draftId, memberId, visibleState.openNomination.id, amount, bidToTaxi)
            if (!isCurrent(actionEpoch) || activeDraftIdRef.current !== requestedDraftId) return
            await load(true)
        } catch (e) {
            if (isCurrent(actionEpoch) && activeDraftIdRef.current === requestedDraftId) showAlert('Bid failed', getErrorMessage(e))
        } finally {
            if (bidRequestRef.current === request) {
                bidRequestRef.current = null
                if (activeIdentityRef.current === identity) setBidding(false)
            }
        }
    }

    async function handleWithdraw() {
        if (!visibleState?.openNomination || !memberId || !draftId) return
        if (!canAct()) return
        const requestedDraftId = draftId
        const actionEpoch = capture()
        setWithdrawing(true)
        try {
            await withdrawNomination(draftId, memberId, visibleState.openNomination.id)
            if (!isCurrent(actionEpoch) || activeDraftIdRef.current !== requestedDraftId) return
            load()
        } catch (e) {
            if (isCurrent(actionEpoch) && activeDraftIdRef.current === requestedDraftId) showAlert('Could not withdraw', getErrorMessage(e))
        } finally {
            if (activeIdentityRef.current === identity) setWithdrawing(false)
        }
    }

    async function handleNominate(playerId: string) {
        if (!memberId || !draftId || !canAct()) return
        const requestedDraftId = draftId
        const actionEpoch = capture()
        if (!realtimeConnected) {
            showAlert('Live connection unavailable', 'Reconnect to the live draft before nominating a player.')
            return
        }
        setSubmittingNom(true)
        try {
            await nominatePlayer(draftId, memberId, playerId)
            if (!isCurrent(actionEpoch) || activeDraftIdRef.current !== requestedDraftId) return
            setNominating(false)
            setSearchQuery('')
            setSearchResults([])
            searchSeqRef.current += 1
            load()
        } catch (e) {
            if (isCurrent(actionEpoch) && activeDraftIdRef.current === requestedDraftId) showAlert('Nomination failed', getErrorMessage(e))
        } finally {
            if (activeIdentityRef.current === identity) setSubmittingNom(false)
        }
    }

    function cancelNominating() {
        setNominating(false)
        setSearchQuery('')
        setSearchResults([])
        searchSeqRef.current += 1
    }

    const realtimeConnected = realtimeStatus === 'SUBSCRIBED' && activity.ready

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

    const refresh = useCallback(async () => {
        // Tap to retry also rebuilds a closed live channel, not only the room data.
        if (realtimeStatus === 'CLOSED') {
            setRealtimeStatus('CONNECTING')
            setSubscriptionEpoch((epoch) => epoch + 1)
            return
        }
        await load()
    }, [load, realtimeStatus])

    return {
        state: visibleState,
        tab,
        setTab,
        loadError: loadError ?? (realtimeStatus !== 'SUBSCRIBED' && realtimeStatus !== 'CONNECTING'
            ? 'Live draft connection lost. Tap to retry.'
            : null),
        bidText,
        bidToTaxi,
        setBidToTaxi,        setBidText,
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
        actionsReady: activity.ready,
        canAct,
        refresh,
        handleBid,
        handleWithdraw,
        handleNominate,
        cancelNominating,
    }
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import {
    activateRookieDraftLeague,
    commissionerSnakePick,
    getRookieDraftPollRevision,
    getRookieDraftState,
    getRookiePlayers,
    makeSnakePick,
    processExpiredSnakePick,
    subscribeToRookieDraft,
    unsubscribeFromRookieDraft,
    type RookieDraftState,
    type RookieProspect,
} from '@/lib/rookieDraft'
import { dropPlayer, getRoster, type RosterPlayer } from '@/lib/roster'
import { getErrorMessage } from '@/lib/shared/errors'
import { reportRealtimeCleanup } from '@/lib/realtime'

type ActiveTab = 'prospects' | 'board'
type RosterOverflow = {
    newPlayerId: string
    newPlayerName: string
    newRosterPlayerId: string | null
    taxiSlotsAvailable: boolean
}
type TrimOverflow = {
    excess: number
    dropList: RosterPlayer[]
}

export function useRookieDraftRoomController({
    draftId,
    memberId,
    leagueId,
    rosterSize,
}: {
    draftId?: string
    memberId?: string
    leagueId?: string
    rosterSize: number
}) {
    const memberIdRef = useRef(memberId)
    memberIdRef.current = memberId

    const [state, setState] = useState<RookieDraftState | null>(null)
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<{ ownerKey: string; message: string } | null>(null)
    const [prospectsError, setProspectsError] = useState<{ ownerKey: string; query: string; message: string } | null>(null)
    const [query, setQuery] = useState('')
    const [prospects, setProspects] = useState<RookieProspect[]>([])
    const [prospectsLoading, setProspectsLoading] = useState(false)
    const [picking, setPicking] = useState(false)
    const [draftToTaxi, setDraftToTaxi] = useState(false)
    const [activeTab, setActiveTab] = useState<ActiveTab>('prospects')
    const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
    const [pickError, setPickError] = useState<string | null>(null)
    const [completionError, setCompletionError] = useState<string | null>(null)
    const [rosterOverflow, setRosterOverflow] = useState<RosterOverflow | null>(null)
    const [rosterForDrop, setRosterForDrop] = useState<RosterPlayer[]>([])
    const [resolvingOverflow, setResolvingOverflow] = useState(false)
    const [trimOverflow, setTrimOverflow] = useState<TrimOverflow | null>(null)
    const [trimmingId, setTrimmingId] = useState<string | null>(null)

    const draftEndCheckedRef = useRef(false)
    const completionEpochRef = useRef(0)
    const completionPhaseRef = useRef<string | null>(null)
    const autoPickAttemptRef = useRef<string | null>(null)
    const channelRef = useRef<ReturnType<typeof subscribeToRookieDraft> | null>(null)
    const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const queryRef = useRef('')
    const lastSearchQueryRef = useRef('')
    const appStateRef = useRef<AppStateStatus>(AppState.currentState)
    const readOwnerKey = `${draftId ?? ''}:${memberId ?? ''}:${leagueId ?? ''}`
    const activeReadOwnerRef = useRef<string | null>(readOwnerKey)
    activeReadOwnerRef.current = readOwnerKey
    const loadSeqRef = useRef(0)
    const prospectsSeqRef = useRef(0)
    const renderedDraftIdRef = useRef(draftId)
    const stateDraftIdRef = useRef(draftId)
    const activeDraftIdRef = useRef(draftId)
    const pollRevisionRef = useRef<string | null>(null)
    const seasonIdentity = stateDraftIdRef.current === draftId && state
        ? `${state.draft.leagueSeasonId}:${state.draft.isCurrentSeason}` : ''
    const ownerIdentity = `${draftId ?? ''}:${memberId ?? ''}:${leagueId ?? ''}:${seasonIdentity}`
    const renderedOwnerRef = useRef(ownerIdentity)
    const activeOwnerRef = useRef(ownerIdentity)
    const mutationGenerationRef = useRef(0)
    const [actionStateOwner, setActionStateOwner] = useState(ownerIdentity)
    activeDraftIdRef.current = draftId
    activeOwnerRef.current = ownerIdentity

    if (renderedOwnerRef.current !== ownerIdentity) {
        renderedOwnerRef.current = ownerIdentity
        mutationGenerationRef.current += 1
        draftEndCheckedRef.current = false
        autoPickAttemptRef.current = null
    }
    const ownsActionState = actionStateOwner === ownerIdentity
    const mutationIsCurrent = (generation: number, identity: string) =>
        mutationGenerationRef.current === generation && activeOwnerRef.current === identity

    if (renderedDraftIdRef.current !== draftId) {
        renderedDraftIdRef.current = draftId
        loadSeqRef.current += 1
        prospectsSeqRef.current += 1
        pollRevisionRef.current = null
        draftEndCheckedRef.current = false
        autoPickAttemptRef.current = null
    }
    useEffect(() => { setDraftToTaxi(false) }, [draftId, memberId])
    const ownsDraft = stateDraftIdRef.current === draftId
    const visibleState = ownsDraft ? state : null
    const draftLeagueMatches = Boolean(leagueId && visibleState?.draft.leagueId === leagueId)
    const draftSeasonIsCurrent = Boolean(visibleState?.draft.leagueSeasonId && visibleState.draft.isCurrentSeason)

    useEffect(() => {
        loadSeqRef.current += 1
        prospectsSeqRef.current += 1
        stateDraftIdRef.current = draftId
        pollRevisionRef.current = null
        draftEndCheckedRef.current = false
        autoPickAttemptRef.current = null
        queryRef.current = ''
        lastSearchQueryRef.current = ''
        setState(null)
        setLoading(Boolean(draftId))
        setLoadError(null)
        setProspectsError(null)
        setQuery('')
        setProspects([])
        setProspectsLoading(Boolean(draftId))
        setPicking(false)
        setActiveTab('prospects')
        setSecondsLeft(null)
        setPickError(null)
        setCompletionError(null)
        setRosterOverflow(null)
        setRosterForDrop([])
        setResolvingOverflow(false)
        setTrimOverflow(null)
        setTrimmingId(null)
    }, [draftId])

    useEffect(() => {
        mutationGenerationRef.current += 1
        setActionStateOwner(ownerIdentity)
        setPicking(false)
        setPickError(null)
        setCompletionError(null)
        setRosterOverflow(null)
        setRosterForDrop([])
        setResolvingOverflow(false)
        setTrimOverflow(null)
        setTrimmingId(null)
    }, [ownerIdentity])

    const load = useCallback(async () => {
        if (activeReadOwnerRef.current !== readOwnerKey) return false
        const requestedDraftId = draftId
        if (!requestedDraftId) {
            setLoading(false)
            return false
        }
        const seq = ++loadSeqRef.current
        try {
            const data = await getRookieDraftState(requestedDraftId)
            if (seq !== loadSeqRef.current || activeDraftIdRef.current !== requestedDraftId || activeReadOwnerRef.current !== readOwnerKey) return false
            setState(data)
            setLoadError(null)
            return true
        } catch (e) {
            if (seq !== loadSeqRef.current || activeDraftIdRef.current !== requestedDraftId || activeReadOwnerRef.current !== readOwnerKey) return false
            console.error(e)
            setLoadError({ ownerKey: readOwnerKey, message: getErrorMessage(e) ?? 'Failed to refresh draft' })
            return false
        } finally {
            if (seq === loadSeqRef.current && activeDraftIdRef.current === requestedDraftId && activeReadOwnerRef.current === readOwnerKey) setLoading(false)
        }
    }, [draftId, readOwnerKey])

    const loadProspects = useCallback(async (q?: string) => {
        if (activeReadOwnerRef.current !== readOwnerKey) return false
        const requestId = ++prospectsSeqRef.current
        const requestedDraftId = draftId
        const requestedQuery = q
        if (!requestedDraftId) {
            setProspects([])
            setProspectsLoading(false)
            return false
        }
        setProspectsLoading(true)
        try {
            const data = await getRookiePlayers(requestedDraftId, requestedQuery)
            if (prospectsSeqRef.current !== requestId || activeDraftIdRef.current !== requestedDraftId || activeReadOwnerRef.current !== readOwnerKey) return false
            setProspects(data)
            setProspectsError(null)
            return true
        } catch (e) {
            if (prospectsSeqRef.current !== requestId || activeDraftIdRef.current !== requestedDraftId || activeReadOwnerRef.current !== readOwnerKey) return false
            console.error(e)
            setProspectsError({ ownerKey: readOwnerKey, query: requestedQuery?.trim() ?? '',
                message: getErrorMessage(e) ?? 'Failed to load prospects' })
            return false
        } finally {
            if (prospectsSeqRef.current === requestId && activeDraftIdRef.current === requestedDraftId && activeReadOwnerRef.current === readOwnerKey) setProspectsLoading(false)
        }
    }, [draftId, readOwnerKey])

    const canRefresh = useCallback(() => appStateRef.current === 'active'
        && (typeof document === 'undefined' || document.visibilityState !== 'hidden'), [])

    const reloadRoom = useMemo(() => {
        let disposed = false
        let pending = false
        let inFlight: Promise<boolean> | null = null
        let timer: ReturnType<typeof setTimeout> | null = null
        const isCurrent = () => !disposed && activeReadOwnerRef.current === readOwnerKey
        const invalidate = () => { loadSeqRef.current += 1; prospectsSeqRef.current += 1 }
        const run = (): Promise<boolean> => {
            if (!isCurrent() || !draftId) return Promise.resolve(false)
            pending = true
            if (inFlight) {
                invalidate()
                return inFlight
            }
            if (timer) clearTimeout(timer)
            timer = null
            const task = (async () => {
                let loaded = false
                try {
                    do {
                        pending = false
                        const results = await Promise.all([load(), loadProspects(queryRef.current.trim() || undefined)])
                        loaded = results.every(Boolean)
                    } while (pending && isCurrent() && canRefresh())
                    return loaded && isCurrent()
                } finally {
                    inFlight = null
                }
            })()
            inFlight = task
            return task
        }
        const trigger = () => {
            if (!isCurrent() || !draftId) return
            pending = true
            if (inFlight) { invalidate(); return }
            if (!canRefresh() || timer) return
            // Later notifications cannot extend the first notification's deadline.
            timer = setTimeout(() => { timer = null; if (canRefresh()) void run() }, 250)
        }
        return {
            run, trigger,
            activate: () => { disposed = false; activeReadOwnerRef.current = readOwnerKey },
            cancel: () => {
                disposed = true
                pending = false
                if (timer) clearTimeout(timer)
                timer = null
                invalidate()
                if (activeReadOwnerRef.current === readOwnerKey) activeReadOwnerRef.current = null
            },
        }
    }, [canRefresh, draftId, load, loadProspects, readOwnerKey])

    useEffect(() => {
        reloadRoom.activate()
        void reloadRoom.run()
        if (!draftId) return reloadRoom.cancel
        let active = true
        let eventRevision = 0
        const requestedDraftId = draftId
        const isCurrent = () => active && activeDraftIdRef.current === requestedDraftId
            && activeReadOwnerRef.current === readOwnerKey
        const channel = subscribeToRookieDraft(requestedDraftId, () => {
            if (!isCurrent()) return
            eventRevision += 1
            pollRevisionRef.current = null
            reloadRoom.trigger()
        })
        channelRef.current = channel
        let polling = false
        let resumePending = false
        let visibilityEpoch = 0
        let foreground = canRefresh()
        const pollRevision = async () => {
            if (!isCurrent() || !canRefresh() || polling) return
            polling = true
            resumePending = false
            const epoch = visibilityEpoch
            const events = eventRevision
            try {
                const revision = await getRookieDraftPollRevision(requestedDraftId)
                if (!isCurrent() || !canRefresh() || epoch !== visibilityEpoch || events !== eventRevision) return
                const previous = pollRevisionRef.current
                if (revision === previous) return
                const loaded = await reloadRoom.run()
                if (loaded && isCurrent() && canRefresh() && epoch === visibilityEpoch && events === eventRevision) pollRevisionRef.current = revision
            } catch (error) {
                if (isCurrent()) console.error(error)
            } finally {
                polling = false
                if (resumePending && isCurrent() && canRefresh()) {
                    resumePending = false
                    void pollRevision()
                }
            }
        }
        const poll = setInterval(() => { void pollRevision() }, 15_000)
        const onVisibility = () => {
            if (!isCurrent()) return
            const nextForeground = canRefresh()
            if (nextForeground === foreground) return
            foreground = nextForeground
            visibilityEpoch += 1
            if (!foreground) return
            if (polling) resumePending = true
            else void pollRevision()
        }
        const appStateSubscription = AppState.addEventListener('change', (nextState) => {
            if (!isCurrent()) return
            appStateRef.current = nextState
            onVisibility()
        })
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        return () => {
            active = false
            reloadRoom.cancel()
            if (channelRef.current === channel) {
                reportRealtimeCleanup('rookie draft', unsubscribeFromRookieDraft(channel))
                channelRef.current = null
            }
            clearInterval(poll)
            appStateSubscription.remove()
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
        }
    }, [canRefresh, draftId, readOwnerKey, reloadRoom])

    useEffect(() => {
        if (!ownsDraft) { queryRef.current = ''; lastSearchQueryRef.current = ''; return }
        queryRef.current = query
        if (query === lastSearchQueryRef.current) return
        lastSearchQueryRef.current = query
        if (searchTimer.current) clearTimeout(searchTimer.current)
        searchTimer.current = setTimeout(() => {
            loadProspects(query.trim() || undefined)
        }, 300)
        return () => {
            if (searchTimer.current) clearTimeout(searchTimer.current)
        }
    }, [query, loadProspects, ownsDraft])

    const clockEnd = useMemo(() => {
        if (visibleState?.draft.status !== 'in_progress') return null
        if (!visibleState.nextPick?.timerExpiresAt) return null
        return new Date(visibleState.nextPick.timerExpiresAt).getTime()
    }, [visibleState?.draft.status, visibleState?.nextPick?.timerExpiresAt])

    useEffect(() => {
        if (!clockEnd) {
            setSecondsLeft(null)
            return
        }
        const tick = () => setSecondsLeft(Math.max(0, Math.ceil((clockEnd - Date.now()) / 1000)))
        tick()
        const id = setInterval(tick, 500)
        return () => clearInterval(id)
    }, [clockEnd])

    useEffect(() => {
        if (secondsLeft !== 0 || !draftId || !visibleState?.nextPick || picking) return
        if (visibleState.draft.timerExpiryBehavior !== 'auto_pick') return
        const stableMemberId = memberIdRef.current ?? memberId
        if (!stableMemberId || visibleState.nextPick.memberId !== stableMemberId) return

        const attemptKey = `${draftId}:${visibleState.nextPick.overallPick}:${visibleState.nextPick.timerExpiresAt ?? ''}`
        if (autoPickAttemptRef.current === attemptKey) return
        autoPickAttemptRef.current = attemptKey

        ;(async () => {
            const generation = mutationGenerationRef.current
            const identity = ownerIdentity
            try {
                await processExpiredSnakePick(draftId, stableMemberId)
                if (mutationIsCurrent(generation, identity)) {
                    await reloadRoom.run()
                }
            } catch (e) {
                if (mutationIsCurrent(generation, identity)) setPickError(getErrorMessage(e) ?? 'Auto-pick failed')
            }
        })()
    }, [draftId, reloadRoom, memberId, ownerIdentity, picking, secondsLeft, visibleState?.draft.timerExpiryBehavior, visibleState?.nextPick])

    const draftCompleted = visibleState?.draft.status === 'completed'
    const completionPhase = draftCompleted && draftSeasonIsCurrent ? `${ownerIdentity}:${visibleState.draft.completedAt ?? ''}` : null
    if (completionPhaseRef.current !== completionPhase) {
        completionPhaseRef.current = completionPhase
        completionEpochRef.current += 1
    }
    useEffect(() => {
        if (draftCompleted && draftSeasonIsCurrent) return
        draftEndCheckedRef.current = false
        setTrimOverflow(null)
        setTrimmingId(null)
        setCompletionError(null)
    }, [draftCompleted, draftSeasonIsCurrent])
    useEffect(() => {
        const stableMemberId = memberIdRef.current ?? memberId
        if (!draftCompleted || !draftSeasonIsCurrent || !draftLeagueMatches || visibleState?.draft.isMock || picking || !stableMemberId || !leagueId || draftEndCheckedRef.current) return

        draftEndCheckedRef.current = true
        setCompletionError(null)
        setRosterOverflow(null)
        setRosterForDrop([])
        ;(async () => {
            const generation = mutationGenerationRef.current
            const identity = ownerIdentity
            const completionEpoch = completionEpochRef.current
            try {
                const roster = await getRoster(stableMemberId, leagueId, visibleState?.draft.leagueSeasonId)
                if (!(mutationIsCurrent(generation, identity) && completionEpochRef.current === completionEpoch)) return
                const active = roster.filter((player) => !player.is_on_ir && !player.is_on_taxi)
                const excess = active.length - rosterSize
                if (excess > 0) {
                    setTrimOverflow({ excess, dropList: active })
                } else if (draftId) {
                    setTrimOverflow(null)
                    await activateRookieDraftLeague(draftId)
                    if (mutationIsCurrent(generation, identity) && completionEpochRef.current === completionEpoch) await load()
                }
            } catch (e) {
                if (mutationIsCurrent(generation, identity) && completionEpochRef.current === completionEpoch) {
                    draftEndCheckedRef.current = false
                    setCompletionError(getErrorMessage(e) ?? 'Could not finish the roster check.')
                }
            }
        })()
    }, [draftCompleted, draftSeasonIsCurrent, draftLeagueMatches, visibleState, picking, draftId, leagueId, rosterSize, memberId, load, ownerIdentity])

    async function handleTrimDrop(rosterPlayerId: string) {
        if (!trimOverflow || completionError || trimmingId || !draftCompleted || !draftSeasonIsCurrent || completionPhaseRef.current !== completionPhase || !visibleState || visibleState.draft.isMock || !draftLeagueMatches ||
            !ownsActionState || activeOwnerRef.current !== ownerIdentity) return
        const generation = mutationGenerationRef.current
        const identity = ownerIdentity
        const completionEpoch = completionEpochRef.current
        setTrimmingId(rosterPlayerId)
        setTrimOverflow(null)
        let dropped = false
        try {
            await dropPlayer(rosterPlayerId, visibleState.draft.leagueSeasonId, draftId)
            if (!(mutationIsCurrent(generation, identity) && completionEpochRef.current === completionEpoch)) return
            dropped = true
            setTrimOverflow(null)
            const stableMemberId = memberIdRef.current ?? memberId
            if (stableMemberId && leagueId) {
                const roster = await getRoster(stableMemberId, leagueId, visibleState?.draft.leagueSeasonId)
                if (!(mutationIsCurrent(generation, identity) && completionEpochRef.current === completionEpoch)) return
                const active = roster.filter((player) => !player.is_on_ir && !player.is_on_taxi)
                const excess = active.length - rosterSize
                setRosterOverflow(null)
                setRosterForDrop([])
                setTrimOverflow(excess <= 0 ? null : { excess, dropList: active })
                if (excess <= 0 && draftId) {
                    await activateRookieDraftLeague(draftId)
                    if (mutationIsCurrent(generation, identity) && completionEpochRef.current === completionEpoch) await load()
                }
            } else {
                setTrimOverflow(null)
            }
        } catch {
            if (mutationIsCurrent(generation, identity) && completionEpochRef.current === completionEpoch) {
                if (dropped) {
                    setCompletionError('Player dropped. Refresh the roster before making another change.')
                } else {
                    setCompletionError('Could not confirm the drop. Refresh the roster before making another change.')
                }
            }
        } finally {
            if (mutationIsCurrent(generation, identity) && completionEpochRef.current === completionEpoch) setTrimmingId(null)
        }
    }

    async function handlePick(player: RookieProspect) {
        const stableMemberId = memberIdRef.current
        if (!draftId || !stableMemberId || picking) return
        const generation = mutationGenerationRef.current
        const identity = ownerIdentity

        setPickError(null)
        setPicking(true)
        try {
            const result = await makeSnakePick(draftId, stableMemberId, player.id, draftToTaxi)
            if (!mutationIsCurrent(generation, identity)) return
            queryRef.current = ''
            setQuery('')
            await reloadRoom.run()
            if (!mutationIsCurrent(generation, identity)) return

            if (result?.rosterOverflow) {
                let newRosterPlayerId: string | null = null
                let dropList: RosterPlayer[] = []
                if (leagueId) {
                    try {
                        const roster = await getRoster(stableMemberId, leagueId, visibleState?.draft.leagueSeasonId)
                        if (!mutationIsCurrent(generation, identity)) return
                        const match = roster.find((rosterPlayer) => rosterPlayer.players?.id === player.id)
                        newRosterPlayerId = match?.id ?? null
                        dropList = roster.filter(
                            (rosterPlayer) =>
                                !rosterPlayer.is_on_ir &&
                                !rosterPlayer.is_on_taxi &&
                                rosterPlayer.players?.id !== player.id,
                        )
                    } catch {
                        if (mutationIsCurrent(generation, identity)) {
                            setPickError('Player drafted, but roster details could not load. Open Roster to resolve any overflow.')
                        }
                        return
                    }
                }
                if (!mutationIsCurrent(generation, identity)) return
                setRosterForDrop(dropList)
                setRosterOverflow({
                    newPlayerId: player.id,
                    newPlayerName: player.display_name,
                    newRosterPlayerId,
                    taxiSlotsAvailable: result.taxiSlotsAvailable,
                })
            }
        } catch (e) {
            if (mutationIsCurrent(generation, identity)) {
                setPickError(getErrorMessage(e) ?? 'Pick failed')
                await reloadRoom.run()
            }
        } finally {
            if (mutationIsCurrent(generation, identity)) setPicking(false)
        }
    }

    async function handleCommissionerPick(player: RookieProspect) {
        const targetMemberId = visibleState?.nextPick?.memberId
        if (!draftId || !targetMemberId || picking) return
        const generation = mutationGenerationRef.current
        const identity = ownerIdentity

        setPickError(null)
        setPicking(true)
        try {
            await commissionerSnakePick(draftId, targetMemberId, player.id, draftToTaxi)
            if (!mutationIsCurrent(generation, identity)) return
            queryRef.current = ''
            setQuery('')
            await reloadRoom.run()
        } catch (e) {
            if (mutationIsCurrent(generation, identity)) {
                setPickError(getErrorMessage(e) ?? 'Commissioner pick failed')
                await reloadRoom.run()
            }
        } finally {
            if (mutationIsCurrent(generation, identity)) setPicking(false)
        }
    }

    async function resolveByDrop(rosterPlayerId: string) {
        if (!rosterOverflow || resolvingOverflow || !draftSeasonIsCurrent || !visibleState || visibleState.draft.isMock || !draftLeagueMatches ||
            !ownsActionState || activeOwnerRef.current !== ownerIdentity) return
        const generation = mutationGenerationRef.current
        const identity = ownerIdentity
        setResolvingOverflow(true)
        setRosterOverflow(null)
        setRosterForDrop([])
        try {
            await dropPlayer(rosterPlayerId, visibleState.draft.leagueSeasonId, draftId)
            if (!mutationIsCurrent(generation, identity)) return
            setRosterOverflow(null)
            if (draftId) {
                await activateRookieDraftLeague(draftId)
                await load()
            }
        } catch {
            if (mutationIsCurrent(generation, identity)) {
                setPickError('Could not finish the roster check. Open Roster to confirm the drop and resolve any overflow.')
            }
        } finally {
            if (mutationIsCurrent(generation, identity)) setResolvingOverflow(false)
        }
    }

    const refresh = useCallback(async () => {
        draftEndCheckedRef.current = false
        await reloadRoom.run()
    }, [reloadRoom])

    const availableProspects = useMemo(() => {
        const picked = new Set(visibleState?.picks.flatMap(pick => pick.player ? [pick.player.id] : []) ?? [])
        return prospects.filter(player => !picked.has(player.id))
    }, [prospects, visibleState?.picks])

    return {
        state: visibleState,
        loading: ownsDraft ? loading : true,
        loadError: loadError?.ownerKey === readOwnerKey ? loadError.message : null,
        prospectsLoadError: prospectsError?.ownerKey === readOwnerKey && prospectsError.query === query.trim()
            ? prospectsError.message : null,
        query,
        setQuery,
        draftToTaxi,
        setDraftToTaxi,
        prospects: ownsDraft ? availableProspects : [],
        prospectsLoading: ownsDraft ? prospectsLoading : true,
        picking: ownsDraft && ownsActionState ? picking : false,
        activeTab,
        setActiveTab,
        secondsLeft,
        pickError: ownsDraft && ownsActionState ? pickError : null,
        completionError: ownsDraft && ownsActionState && draftCompleted && draftSeasonIsCurrent ? completionError : null,
        rosterOverflow: ownsDraft && ownsActionState && draftLeagueMatches && draftSeasonIsCurrent && !draftCompleted ? rosterOverflow : null,
        rosterForDrop: ownsDraft && ownsActionState ? rosterForDrop : [],
        resolvingOverflow: ownsDraft && ownsActionState ? resolvingOverflow : false,
        trimOverflow: ownsDraft && ownsActionState && draftLeagueMatches && draftSeasonIsCurrent && draftCompleted ? trimOverflow : null,
        trimmingId: ownsDraft && ownsActionState ? trimmingId : null,
        memberId: memberId ?? memberIdRef.current,
        refresh,
        handleTrimDrop,
        handlePick,
        handleCommissionerPick,
        resolveByDrop,
    }
}

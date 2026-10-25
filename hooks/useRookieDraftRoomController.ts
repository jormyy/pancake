import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { sessionOwner } from '@/lib/session-cache-registry'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDraftActivity } from '@/components/league/draft-room/useDraftActivity'
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

    const cacheKey = `pancake:rookie-room:v1:${sessionOwner()}:${memberId}:${leagueId}:${draftId}`
    const [initialCache] = useState(() => readPersistentCache<{ state: RookieDraftState | null }>(cacheKey))
    const [initialProspects] = useState(() => readPersistentCache<RookieProspect[]>(`${cacheKey}:prospects`))
    const [state, setState] = useState<RookieDraftState | null>(initialCache?.state ?? null)
    const [loading, setLoading] = useState(!initialCache)
    const [loadError, setLoadError] = useState<{ ownerKey: string; message: string } | null>(null)
    const [prospectsError, setProspectsError] = useState<{ ownerKey: string; query: string; message: string } | null>(null)
    const [query, setQuery] = useState('')
    const [prospects, setProspects] = useState<RookieProspect[]>(initialProspects ?? [])
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

    const completionErrorRef = useRef(completionError)
    completionErrorRef.current = completionError
    const draftEndCheckedRef = useRef(false)
    const completionEpochRef = useRef(0)
    const completionPhaseRef = useRef<string | null>(null)
    const autoPickAttemptRef = useRef<{
        key: string; attempts: number; nextAt: number; inFlight: boolean; completed: boolean
    } | null>(null)
    const roomSnapshotRef = useRef<RookieDraftState | null>(initialCache?.state ?? null)
    const prospectsDirtyRef = useRef(true)
    const channelRef = useRef<ReturnType<typeof subscribeToRookieDraft> | null>(null)
    const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const queryRef = useRef('')
    const lastSearchQueryRef = useRef('')
    const activity = useDraftActivity(draftId && memberId && leagueId ? `${draftId}:${memberId}:${leagueId}` : null)
    const { epoch, capture, canRead: canRefresh, isCurrent: activityIsCurrent, canAct, markReady, blockActions } = activity
    const readOwnerKey = activity.identity
    const stateOwnerRef = useRef(readOwnerKey)
    const renderedReadOwnerRef = useRef(readOwnerKey)
    const activeReadOwnerRef = useRef<string | null>(readOwnerKey)
    activeReadOwnerRef.current = readOwnerKey
    const loadSeqRef = useRef(0)
    const prospectsSeqRef = useRef(0)
    const activeDraftIdRef = useRef(draftId)
    const pollRevisionRef = useRef<string | null>(null)
    const seasonIdentity = stateOwnerRef.current === readOwnerKey && state
        ? `${state.draft.leagueSeasonId}:${state.draft.isCurrentSeason}` : ''
    const ownerIdentity = `${readOwnerKey}:${seasonIdentity}`
    const renderedActivityEpochRef = useRef(epoch)
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
    if (renderedActivityEpochRef.current !== epoch) {
        renderedActivityEpochRef.current = epoch
        mutationGenerationRef.current += 1
    }
    const ownsActionState = actionStateOwner === ownerIdentity
    const mutationIsCurrent = useCallback((generation: number, identity: string) =>
        canAct() && mutationGenerationRef.current === generation && activeOwnerRef.current === identity, [canAct])

    if (renderedReadOwnerRef.current !== readOwnerKey) {
        renderedReadOwnerRef.current = readOwnerKey
        loadSeqRef.current += 1
        prospectsSeqRef.current += 1
        pollRevisionRef.current = null
        draftEndCheckedRef.current = false
        autoPickAttemptRef.current = null
    }
    useEffect(() => { setDraftToTaxi(false) }, [draftId, memberId])
    const ownsDraft = stateOwnerRef.current === readOwnerKey
    const visibleState = ownsDraft ? state : null
    const draftLeagueMatches = Boolean(leagueId && visibleState?.draft.leagueId === leagueId)
    const draftSeasonIsCurrent = Boolean(visibleState?.draft.leagueSeasonId && visibleState.draft.isCurrentSeason)

    useEffect(() => {
        loadSeqRef.current += 1
        prospectsSeqRef.current += 1
        stateOwnerRef.current = readOwnerKey
        pollRevisionRef.current = null
        draftEndCheckedRef.current = false
        autoPickAttemptRef.current = null
        queryRef.current = ''
        lastSearchQueryRef.current = ''
        const cached = readPersistentCache<{ state: RookieDraftState | null }>(cacheKey)
        const prospects = readPersistentCache<RookieProspect[]>(`${cacheKey}:prospects`)
        roomSnapshotRef.current = cached?.state ?? null
        prospectsDirtyRef.current = true
        setState(cached?.state ?? null)
        setLoading(Boolean(draftId) && !cached)
        setLoadError(null)
        setProspectsError(null)
        setQuery('')
        setProspects(prospects ?? [])
        setProspectsLoading(Boolean(draftId) && !prospects)
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
    }, [draftId, readOwnerKey, cacheKey])

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

    const load = useCallback(async (deferInitialPaint = false) => {
        if (!canRefresh() || activeReadOwnerRef.current !== readOwnerKey) return false
        const readEpoch = capture()
        const requestedDraftId = draftId
        if (!requestedDraftId) {
            setLoading(false)
            return false
        }
        const seq = ++loadSeqRef.current
        try {
            const data = await getRookieDraftState(requestedDraftId)
            if (!activityIsCurrent(readEpoch) || seq !== loadSeqRef.current || activeDraftIdRef.current !== requestedDraftId || activeReadOwnerRef.current !== readOwnerKey) return false
            const previous = roomSnapshotRef.current
            const picked = new Set(data?.picks.flatMap(pick => pick.player ? [pick.player.id] : []) ?? [])
            if (previous?.draft.leagueSeasonId !== data?.draft.leagueSeasonId
                || previous?.picks.some(pick => pick.player && !picked.has(pick.player.id))) {
                prospectsDirtyRef.current = true
            }
            writePersistentCache(cacheKey, { state: data })
            roomSnapshotRef.current = data
            if (!deferInitialPaint) setState(data)
            setLoadError(null)
            return true
        } catch (e) {
            if (!activityIsCurrent(readEpoch) || seq !== loadSeqRef.current || activeDraftIdRef.current !== requestedDraftId || activeReadOwnerRef.current !== readOwnerKey) return false
            console.error(e)
            setLoadError({ ownerKey: readOwnerKey, message: getErrorMessage(e) ?? 'Failed to refresh draft' })
            return false
        } finally {
            if (!deferInitialPaint && activityIsCurrent(readEpoch) && seq === loadSeqRef.current && activeDraftIdRef.current === requestedDraftId && activeReadOwnerRef.current === readOwnerKey) setLoading(false)
        }
    }, [draftId, readOwnerKey, capture, canRefresh, activityIsCurrent, cacheKey])

    const loadProspects = useCallback(async (q?: string) => {
        if (!canRefresh() || activeReadOwnerRef.current !== readOwnerKey) return false
        const readEpoch = capture()
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
            if (!activityIsCurrent(readEpoch) || prospectsSeqRef.current !== requestId || activeDraftIdRef.current !== requestedDraftId || activeReadOwnerRef.current !== readOwnerKey) return false
            prospectsDirtyRef.current = false
            lastSearchQueryRef.current = requestedQuery?.trim() ?? ''
            if (!requestedQuery?.trim()) writePersistentCache(`${cacheKey}:prospects`, data)
            setProspects(data)
            setProspectsError(null)
            return true
        } catch (e) {
            if (!activityIsCurrent(readEpoch) || prospectsSeqRef.current !== requestId || activeDraftIdRef.current !== requestedDraftId || activeReadOwnerRef.current !== readOwnerKey) return false
            prospectsDirtyRef.current = true
            console.error(e)
            setProspectsError({ ownerKey: readOwnerKey, query: requestedQuery?.trim() ?? '',
                message: getErrorMessage(e) ?? 'Failed to load prospects' })
            return false
        } finally {
            if (activityIsCurrent(readEpoch) && prospectsSeqRef.current === requestId && activeDraftIdRef.current === requestedDraftId && activeReadOwnerRef.current === readOwnerKey) setProspectsLoading(false)
        }
    }, [draftId, readOwnerKey, capture, canRefresh, activityIsCurrent, cacheKey])

    const reloadRoom = useMemo(() => {
        let disposed = false
        let pending = false
        let poolPending = false
        let inFlight: Promise<boolean> | null = null
        let inFlightEpoch = -1
        let timer: ReturnType<typeof setTimeout> | null = null
        const isCurrent = () => !disposed && activeReadOwnerRef.current === readOwnerKey
        const invalidate = () => { loadSeqRef.current += 1; prospectsSeqRef.current += 1 }
        const run = (refreshProspects = false, catchUp = false): Promise<boolean> => {
            if (!isCurrent() || !draftId) return Promise.resolve(false)
            if (catchUp && inFlight && inFlightEpoch === capture()) {
                poolPending ||= refreshProspects
                return inFlight
            }
            pending = true
            poolPending ||= refreshProspects
            if (!canRefresh()) return Promise.resolve(false)
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
                        const readEpoch = capture()
                        inFlightEpoch = readEpoch
                        const refreshPool = poolPending || prospectsDirtyRef.current
                        poolPending = false
                        const poolRead = refreshPool && isCurrent() && canRefresh()
                            ? loadProspects(queryRef.current.trim() || undefined) : null
                        const deferInitialPaint = roomSnapshotRef.current === null
                        const stateLoaded = await load(deferInitialPaint)
                        const poolLoaded = poolRead ? await poolRead
                            : prospectsDirtyRef.current && isCurrent() && canRefresh()
                                ? await loadProspects(queryRef.current.trim() || undefined) : true
                        loaded = stateLoaded && poolLoaded && activityIsCurrent(readEpoch)
                        if (deferInitialPaint && activityIsCurrent(readEpoch) && !pending) {
                            setState(roomSnapshotRef.current)
                            setLoading(false)
                        }
                        if (loaded && poolRead) prospectsDirtyRef.current = false
                        if (loaded) markReady(readEpoch)
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
            suspend: () => {
                pending = true
                invalidate()
                if (timer) clearTimeout(timer)
                timer = null
            },
            activate: () => { disposed = false; activeReadOwnerRef.current = readOwnerKey },
            cancel: () => {
                inFlightEpoch = -1
                disposed = true
                pending = false
                if (timer) clearTimeout(timer)
                timer = null
                invalidate()
                if (activeReadOwnerRef.current === readOwnerKey) activeReadOwnerRef.current = null
            },
        }
    }, [canRefresh, draftId, load, loadProspects, readOwnerKey, capture, activityIsCurrent, markReady])

    useEffect(() => {
        reloadRoom.activate()
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
        }, async () => {
            if (!isCurrent()) return false
            eventRevision += 1
            pollRevisionRef.current = null
            blockActions()
            return reloadRoom.run(true, true)
        })
        channelRef.current = channel
        let polling = false
        const pollRevision = async () => {
            if (!isCurrent() || !canRefresh() || polling) return
            polling = true
            const readEpoch = capture()
            const events = eventRevision
            try {
                const revision = await getRookieDraftPollRevision(requestedDraftId)
                if (!isCurrent() || !canRefresh() || !activityIsCurrent(readEpoch) || events !== eventRevision) return
                const previous = pollRevisionRef.current
                if (revision === previous && !prospectsDirtyRef.current) return
                const loaded = await reloadRoom.run()
                if (loaded && isCurrent() && canRefresh() && activityIsCurrent(readEpoch) && events === eventRevision) pollRevisionRef.current = revision
            } catch (error) {
                if (isCurrent()) console.error(error)
            } finally {
                polling = false
            }
        }
        const poll = setInterval(() => { void pollRevision() }, 15_000)
        return () => {
            active = false
            reloadRoom.cancel()
            if (channelRef.current === channel) {
                reportRealtimeCleanup('rookie draft', unsubscribeFromRookieDraft(channel))
                channelRef.current = null
            }
            clearInterval(poll)
        }
    }, [canRefresh, draftId, readOwnerKey, reloadRoom, capture, activityIsCurrent, blockActions])

    useEffect(() => {
        pollRevisionRef.current = null
        if (canRefresh() && !canAct()) void reloadRoom.run(false, true)
        else if (!canRefresh()) {
            if (!completionErrorRef.current) {
                draftEndCheckedRef.current = false
                setTrimOverflow(null)
            }
            reloadRoom.suspend()
        }
    }, [epoch, canRefresh, canAct, reloadRoom])

    useEffect(() => {
        if (!ownsDraft) { queryRef.current = ''; lastSearchQueryRef.current = ''; return }
        queryRef.current = query
        if (!canAct()) {
            if (query.trim() !== lastSearchQueryRef.current) prospectsDirtyRef.current = true
            return
        }
        if (query === lastSearchQueryRef.current) return
        lastSearchQueryRef.current = query
        if (searchTimer.current) clearTimeout(searchTimer.current)
        searchTimer.current = setTimeout(() => {
            if (canAct()) void loadProspects(query.trim() || undefined)
            else prospectsDirtyRef.current = true
        }, 300)
        return () => {
            if (searchTimer.current) clearTimeout(searchTimer.current)
        }
    }, [query, loadProspects, ownsDraft, canAct, activity.ready])

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
        if (!canRefresh()) return
        const tick = () => {
            if (canRefresh()) setSecondsLeft(Math.max(0, Math.ceil((clockEnd - Date.now()) / 1000)))
        }
        tick()
        const id = setInterval(tick, 1_000)
        return () => clearInterval(id)
    }, [clockEnd, canRefresh, epoch])

    useEffect(() => {
        if (secondsLeft !== 0 || !draftId || !visibleState?.nextPick || picking
            || visibleState.draft.status !== 'in_progress' || !draftSeasonIsCurrent) return
        if (visibleState.draft.timerExpiryBehavior !== 'auto_pick') return
        const stableMemberId = memberIdRef.current ?? memberId
        if (!stableMemberId || visibleState.nextPick.memberId !== stableMemberId) return
        const key = `${draftId}:${visibleState.nextPick.overallPick}:${visibleState.nextPick.timerExpiresAt ?? ''}`
        if (autoPickAttemptRef.current?.key !== key) {
            autoPickAttemptRef.current = { key, attempts: 0, nextAt: 0, inFlight: false, completed: false }
        }
        const attempt = autoPickAttemptRef.current
        let active = true
        let retry: ReturnType<typeof setTimeout> | undefined
        const generation = mutationGenerationRef.current
        const identity = ownerIdentity
        const isCurrent = () => active && mutationIsCurrent(generation, identity)
            && autoPickAttemptRef.current === attempt
        const run = async () => {
            if (!isCurrent() || attempt.completed) return
            if (!attempt.inFlight && canAct()
                && performance.now() >= attempt.nextAt) {
                attempt.inFlight = true
                attempt.attempts += 1
                attempt.nextAt = performance.now() + [2000, 5000, 10000, 30000][Math.min(attempt.attempts - 1, 3)]
                try {
                    const result = await processExpiredSnakePick(draftId, stableMemberId)
                    if (isCurrent()) {
                        attempt.completed = result?.processed === true
                        setPickError(null)
                        await reloadRoom.run()
                    }
                } catch (e) {
                    if (isCurrent()) setPickError(getErrorMessage(e) ?? 'Auto-pick failed')
                } finally {
                    attempt.inFlight = false
                }
            }
            if (isCurrent() && !attempt.completed) {
                retry = setTimeout(() => { void run() }, Math.max(500, attempt.nextAt - performance.now()))
            }
        }
        void run()
        return () => { active = false; if (retry) clearTimeout(retry) }
    }, [canAct, draftId, draftSeasonIsCurrent, reloadRoom, memberId, ownerIdentity, picking, secondsLeft,
        visibleState?.draft.status, visibleState?.draft.timerExpiryBehavior, visibleState?.nextPick, mutationIsCurrent, epoch, activity.ready])

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
        if (!canAct() || completionError || !draftCompleted || !draftSeasonIsCurrent || !draftLeagueMatches || visibleState?.draft.isMock || picking || !stableMemberId || !leagueId || draftEndCheckedRef.current) return

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
    }, [draftCompleted, draftSeasonIsCurrent, draftLeagueMatches, visibleState, picking, draftId, leagueId, rosterSize, memberId, load, ownerIdentity, canAct, activity.ready, mutationIsCurrent, completionError])

    async function handleTrimDrop(rosterPlayerId: string) {
        if (!canAct() || !trimOverflow || completionError || trimmingId || !draftCompleted || !draftSeasonIsCurrent || completionPhaseRef.current !== completionPhase || !visibleState || visibleState.draft.isMock || !draftLeagueMatches ||
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
            if (activeOwnerRef.current === identity && completionEpochRef.current === completionEpoch) setTrimmingId(null)
        }
    }

    async function handlePick(player: RookieProspect) {
        const stableMemberId = memberIdRef.current
        if (!canAct() || !draftId || !stableMemberId || picking) return
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
            if (activeOwnerRef.current === identity) setPicking(false)
        }
    }

    async function handleCommissionerPick(player: RookieProspect) {
        const targetMemberId = visibleState?.nextPick?.memberId
        if (!canAct() || !draftId || !targetMemberId || picking) return
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
            if (activeOwnerRef.current === identity) setPicking(false)
        }
    }

    async function resolveByDrop(rosterPlayerId: string) {
        if (!canAct() || !rosterOverflow || resolvingOverflow || !draftSeasonIsCurrent || !visibleState || visibleState.draft.isMock || !draftLeagueMatches ||
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
            if (draftId) await load()
        } catch {
            if (mutationIsCurrent(generation, identity)) {
                setPickError('Could not finish the roster check. Open Roster to confirm the drop and resolve any overflow.')
            }
        } finally {
            if (activeOwnerRef.current === identity) setResolvingOverflow(false)
        }
    }

    const refresh = useCallback(async () => {
        setCompletionError(null)
        draftEndCheckedRef.current = false
        await reloadRoom.run(true)
    }, [reloadRoom])

    const availableProspects = useMemo(() => {
        const picked = new Set(visibleState?.picks.flatMap(pick => pick.player ? [pick.player.id] : []) ?? [])
        return prospects.filter(player => !picked.has(player.id))
    }, [prospects, visibleState?.picks])

    return {
        state: visibleState,
        actionsReady: activity.ready,
        canAct,
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

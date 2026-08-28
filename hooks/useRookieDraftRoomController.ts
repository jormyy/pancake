import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, AppState, type AppStateStatus } from 'react-native'
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
import { dropPlayer, getRoster, toggleTaxi, type RosterPlayer } from '@/lib/roster'
import { getErrorMessage } from '@/lib/shared/errors'
import { getRosterStatusChangeLockMessage } from '@/lib/roster-locks'
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
    const [query, setQuery] = useState('')
    const [prospects, setProspects] = useState<RookieProspect[]>([])
    const [prospectsLoading, setProspectsLoading] = useState(false)
    const [picking, setPicking] = useState(false)
    const [activeTab, setActiveTab] = useState<ActiveTab>('prospects')
    const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
    const [pickError, setPickError] = useState<string | null>(null)
    const [rosterOverflow, setRosterOverflow] = useState<RosterOverflow | null>(null)
    const [rosterForDrop, setRosterForDrop] = useState<RosterPlayer[]>([])
    const [resolvingOverflow, setResolvingOverflow] = useState(false)
    const [trimOverflow, setTrimOverflow] = useState<TrimOverflow | null>(null)
    const [trimmingId, setTrimmingId] = useState<string | null>(null)

    const draftEndCheckedRef = useRef(false)
    const autoPickAttemptRef = useRef<string | null>(null)
    const channelRef = useRef<ReturnType<typeof subscribeToRookieDraft> | null>(null)
    const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const queryRef = useRef('')
    const loadSeqRef = useRef(0)
    const prospectsSeqRef = useRef(0)
    const renderedDraftIdRef = useRef(draftId)
    const stateDraftIdRef = useRef(draftId)
    const activeDraftIdRef = useRef(draftId)
    const pollRevisionRef = useRef<string | null>(null)
    const ownerIdentity = `${draftId ?? ''}:${memberId ?? ''}:${leagueId ?? ''}`
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
    const ownsDraft = stateDraftIdRef.current === draftId
    const visibleState = ownsDraft ? state : null

    useEffect(() => {
        loadSeqRef.current += 1
        prospectsSeqRef.current += 1
        stateDraftIdRef.current = draftId
        pollRevisionRef.current = null
        draftEndCheckedRef.current = false
        autoPickAttemptRef.current = null
        queryRef.current = ''
        setState(null)
        setLoading(Boolean(draftId))
        setQuery('')
        setProspects([])
        setProspectsLoading(Boolean(draftId))
        setPicking(false)
        setActiveTab('prospects')
        setSecondsLeft(null)
        setPickError(null)
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
        setRosterOverflow(null)
        setRosterForDrop([])
        setResolvingOverflow(false)
        setTrimOverflow(null)
        setTrimmingId(null)
    }, [ownerIdentity])

    const load = useCallback(async () => {
        const requestedDraftId = draftId
        if (!requestedDraftId) {
            setLoading(false)
            return
        }
        const seq = ++loadSeqRef.current
        try {
            const data = await getRookieDraftState(requestedDraftId)
            if (seq !== loadSeqRef.current || activeDraftIdRef.current !== requestedDraftId) return
            if (data) setState(data)
        } catch (e) {
            if (seq !== loadSeqRef.current || activeDraftIdRef.current !== requestedDraftId) return
            console.error(e)
            setPickError(getErrorMessage(e) ?? 'Failed to refresh draft')
        } finally {
            if (seq === loadSeqRef.current && activeDraftIdRef.current === requestedDraftId) setLoading(false)
        }
    }, [draftId])

    const loadProspects = useCallback(async (q?: string) => {
        const requestId = ++prospectsSeqRef.current
        const requestedDraftId = draftId
        const requestedQuery = q
        if (!requestedDraftId) {
            setProspects([])
            setProspectsLoading(false)
            return
        }
        setProspectsLoading(true)
        try {
            const data = await getRookiePlayers(requestedDraftId, requestedQuery)
            if (prospectsSeqRef.current !== requestId || activeDraftIdRef.current !== requestedDraftId) return
            setProspects(data)
        } catch (e) {
            if (prospectsSeqRef.current !== requestId || activeDraftIdRef.current !== requestedDraftId) return
            console.error(e)
        } finally {
            if (prospectsSeqRef.current === requestId && activeDraftIdRef.current === requestedDraftId) setProspectsLoading(false)
        }
    }, [draftId])

    useEffect(() => {
        void load()
        if (!draftId) return
        const requestedDraftId = draftId
        const channel = subscribeToRookieDraft(requestedDraftId, () => {
            pollRevisionRef.current = null
            void load()
            void loadProspects(queryRef.current.trim() || undefined)
        })
        channelRef.current = channel
        let appState: AppStateStatus = AppState.currentState
        const pollRevision = async () => {
            if (appState !== 'active' || activeDraftIdRef.current !== requestedDraftId) return
            try {
                const revision = await getRookieDraftPollRevision(requestedDraftId)
                if (activeDraftIdRef.current !== requestedDraftId) return
                const previous = pollRevisionRef.current
                pollRevisionRef.current = revision
                if (previous !== null && revision !== previous) await load()
            } catch (error) {
                if (activeDraftIdRef.current === requestedDraftId) console.error(error)
            }
        }
        const poll = setInterval(() => { void pollRevision() }, 15_000)
        const appStateSubscription = AppState.addEventListener('change', (nextState) => {
            const becameActive = appState !== 'active' && nextState === 'active'
            appState = nextState
            if (becameActive) void pollRevision()
        })
        return () => {
            if (channelRef.current === channel) {
                reportRealtimeCleanup('rookie draft', unsubscribeFromRookieDraft(channel))
                channelRef.current = null
            }
            clearInterval(poll)
            appStateSubscription.remove()
        }
    }, [draftId, load, loadProspects])

    useEffect(() => {
        loadProspects()
    }, [loadProspects])

    useEffect(() => {
        queryRef.current = query
        if (searchTimer.current) clearTimeout(searchTimer.current)
        searchTimer.current = setTimeout(() => {
            loadProspects(query.trim() || undefined)
        }, 300)
        return () => {
            if (searchTimer.current) clearTimeout(searchTimer.current)
        }
    }, [query, loadProspects])

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
                    await Promise.all([load(), loadProspects(queryRef.current.trim() || undefined)])
                }
            } catch (e) {
                if (mutationIsCurrent(generation, identity)) setPickError(getErrorMessage(e) ?? 'Auto-pick failed')
            }
        })()
    }, [draftId, load, loadProspects, memberId, ownerIdentity, picking, secondsLeft, visibleState?.draft.timerExpiryBehavior, visibleState?.nextPick])

    const draftCompleted = visibleState?.draft.status === 'completed'
    useEffect(() => {
        const stableMemberId = memberIdRef.current ?? memberId
        if (!draftCompleted || !stableMemberId || !leagueId || draftEndCheckedRef.current) return

        draftEndCheckedRef.current = true
        ;(async () => {
            const generation = mutationGenerationRef.current
            const identity = ownerIdentity
            try {
                const roster = await getRoster(stableMemberId, leagueId)
                if (!mutationIsCurrent(generation, identity)) return
                const active = roster.filter((player) => !player.is_on_ir && !player.is_on_taxi)
                const excess = active.length - rosterSize
                if (excess > 0) {
                    setTrimOverflow({ excess, dropList: active })
                } else if (draftId) {
                    setTrimOverflow(null)
                    await activateRookieDraftLeague(draftId)
                    if (mutationIsCurrent(generation, identity)) await load()
                }
            } catch (e) {
                if (mutationIsCurrent(generation, identity)) console.error('[rookie-draft] post-draft roster check:', e)
            }
        })()
    }, [draftCompleted, draftId, leagueId, rosterSize, memberId, load, ownerIdentity])

    async function handleTrimDrop(rosterPlayerId: string) {
        if (trimmingId) return
        const generation = mutationGenerationRef.current
        const identity = ownerIdentity
        setTrimmingId(rosterPlayerId)
        try {
            await dropPlayer(rosterPlayerId)
            if (!mutationIsCurrent(generation, identity)) return
            const stableMemberId = memberIdRef.current ?? memberId
            if (stableMemberId && leagueId) {
                const roster = await getRoster(stableMemberId, leagueId)
                if (!mutationIsCurrent(generation, identity)) return
                const active = roster.filter((player) => !player.is_on_ir && !player.is_on_taxi)
                const excess = active.length - rosterSize
                setTrimOverflow(excess <= 0 ? null : { excess, dropList: active })
                if (excess <= 0 && draftId) {
                    await activateRookieDraftLeague(draftId)
                    if (mutationIsCurrent(generation, identity)) await load()
                }
            } else {
                setTrimOverflow(null)
            }
        } catch (e) {
            if (mutationIsCurrent(generation, identity)) Alert.alert('Error', getErrorMessage(e) ?? 'Failed to drop player')
        } finally {
            if (mutationIsCurrent(generation, identity)) setTrimmingId(null)
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
            const result = await makeSnakePick(draftId, stableMemberId, player.id)
            if (!mutationIsCurrent(generation, identity)) return
            setQuery('')
            await Promise.all([load(), loadProspects()])
            if (!mutationIsCurrent(generation, identity)) return

            if (result?.rosterOverflow) {
                let newRosterPlayerId: string | null = null
                let dropList: RosterPlayer[] = []
                if (leagueId) {
                    try {
                        const roster = await getRoster(stableMemberId, leagueId)
                        if (!mutationIsCurrent(generation, identity)) return
                        const match = roster.find((rosterPlayer) => rosterPlayer.players?.id === player.id)
                        newRosterPlayerId = match?.id ?? null
                        dropList = roster.filter(
                            (rosterPlayer) =>
                                !rosterPlayer.is_on_ir &&
                                !rosterPlayer.is_on_taxi &&
                                rosterPlayer.players?.id !== player.id,
                        )
                    } catch (e) {
                        console.error('[rookie-draft] overflow roster fetch:', e)
                    }
                }
                setRosterForDrop(dropList)
                setRosterOverflow({
                    newPlayerId: player.id,
                    newPlayerName: player.display_name,
                    newRosterPlayerId,
                    taxiSlotsAvailable: result.taxiSlotsAvailable,
                })
            }
        } catch (e) {
            if (mutationIsCurrent(generation, identity)) setPickError(getErrorMessage(e) ?? 'Pick failed')
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
            await commissionerSnakePick(draftId, targetMemberId, player.id)
            if (!mutationIsCurrent(generation, identity)) return
            setQuery('')
            await Promise.all([load(), loadProspects()])
        } catch (e) {
            if (mutationIsCurrent(generation, identity)) setPickError(getErrorMessage(e) ?? 'Commissioner pick failed')
        } finally {
            if (mutationIsCurrent(generation, identity)) setPicking(false)
        }
    }

    async function resolveByTaxi() {
        if (!rosterOverflow?.newRosterPlayerId || resolvingOverflow) return
        const generation = mutationGenerationRef.current
        const identity = ownerIdentity
        const requestedRosterPlayerId = rosterOverflow.newRosterPlayerId
        setResolvingOverflow(true)
        try {
            const stableMemberId = memberIdRef.current ?? memberId
            if (stableMemberId && leagueId) {
                const roster = await getRoster(stableMemberId, leagueId)
                if (!mutationIsCurrent(generation, identity)) return
                const rookie = roster.find((rosterPlayer) => rosterPlayer.id === requestedRosterPlayerId)
                const lockMessage = await getRosterStatusChangeLockMessage(rookie)
                if (!mutationIsCurrent(generation, identity)) return
                if (lockMessage) {
                    Alert.alert('Roster locked', lockMessage)
                    return
                }
            }

            await toggleTaxi(requestedRosterPlayerId, true)
            if (!mutationIsCurrent(generation, identity)) return
            setRosterOverflow(null)
            if (draftId) {
                await activateRookieDraftLeague(draftId)
                await load()
            }
        } catch (e) {
            if (mutationIsCurrent(generation, identity)) Alert.alert('Error', getErrorMessage(e) ?? 'Failed to move to taxi')
        } finally {
            if (mutationIsCurrent(generation, identity)) setResolvingOverflow(false)
        }
    }

    async function resolveByDrop(rosterPlayerId: string) {
        if (resolvingOverflow) return
        const generation = mutationGenerationRef.current
        const identity = ownerIdentity
        setResolvingOverflow(true)
        try {
            await dropPlayer(rosterPlayerId)
            if (!mutationIsCurrent(generation, identity)) return
            setRosterOverflow(null)
            if (draftId) {
                await activateRookieDraftLeague(draftId)
                await load()
            }
        } catch (e) {
            if (mutationIsCurrent(generation, identity)) Alert.alert('Error', getErrorMessage(e) ?? 'Failed to drop player')
        } finally {
            if (mutationIsCurrent(generation, identity)) setResolvingOverflow(false)
        }
    }

    return {
        state: visibleState,
        loading: ownsDraft ? loading : true,
        query,
        setQuery,
        prospects: ownsDraft ? prospects : [],
        prospectsLoading: ownsDraft ? prospectsLoading : true,
        picking: ownsDraft && ownsActionState ? picking : false,
        activeTab,
        setActiveTab,
        secondsLeft,
        pickError: ownsDraft && ownsActionState ? pickError : null,
        rosterOverflow: ownsDraft && ownsActionState ? rosterOverflow : null,
        rosterForDrop: ownsDraft && ownsActionState ? rosterForDrop : [],
        resolvingOverflow: ownsDraft && ownsActionState ? resolvingOverflow : false,
        trimOverflow: ownsDraft && ownsActionState ? trimOverflow : null,
        trimmingId: ownsDraft && ownsActionState ? trimmingId : null,
        memberId: memberId ?? memberIdRef.current,
        refresh: load,
        handleTrimDrop,
        handlePick,
        handleCommissionerPick,
        resolveByTaxi,
        resolveByDrop,
    }
}

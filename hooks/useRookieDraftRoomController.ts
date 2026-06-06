import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert } from 'react-native'
import {
    activateRookieDraftLeague,
    autoPickBest,
    getRookieDraftState,
    getRookiePlayers,
    makeSnakePick,
    subscribeToRookieDraft,
    unsubscribeFromRookieDraft,
    type RookieDraftState,
    type RookieProspect,
} from '@/lib/rookieDraft'
import { dropPlayer, getRoster, toggleTaxi, type RosterPlayer } from '@/lib/roster'
import { getErrorMessage } from '@/lib/alert'

const PICK_TIMEOUT_SEC = 30

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
    const memberIdRef = useRef<string | undefined>(undefined)
    if (memberId) memberIdRef.current = memberId

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

    const autoPickFiredRef = useRef(false)
    const draftEndCheckedRef = useRef(false)
    const channelRef = useRef<ReturnType<typeof subscribeToRookieDraft> | null>(null)
    const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const queryRef = useRef('')

    const load = useCallback(async () => {
        if (!draftId) {
            setLoading(false)
            return
        }
        const data = await getRookieDraftState(draftId)
        setState(data)
        setLoading(false)
    }, [draftId])

    const loadProspects = useCallback(async (q?: string) => {
        if (!draftId) return
        setProspectsLoading(true)
        const data = await getRookiePlayers(draftId, q)
        setProspects(data)
        setProspectsLoading(false)
    }, [draftId])

    useEffect(() => {
        load()
        if (!draftId) return
        channelRef.current = subscribeToRookieDraft(draftId, () => {
            load()
            loadProspects(queryRef.current.trim() || undefined)
        })
        return () => {
            if (channelRef.current) unsubscribeFromRookieDraft(channelRef.current)
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

    const madePicksForClock = useMemo(
        () => (state?.picks ?? []).filter((pick) => pick.player).sort((a, b) => b.overallPick - a.overallPick),
        [state?.picks],
    )
    const clockEnd = useMemo(() => {
        if (state?.draft.status !== 'in_progress') return null
        const start = madePicksForClock[0]?.pickedAt ?? state.draft.startedAt
        if (!start) return null
        return new Date(start).getTime() + PICK_TIMEOUT_SEC * 1000
    }, [state?.draft.status, state?.draft.startedAt, madePicksForClock])

    useEffect(() => {
        if (!clockEnd) {
            setSecondsLeft(null)
            return
        }
        autoPickFiredRef.current = false
        const tick = () => setSecondsLeft(Math.max(0, Math.ceil((clockEnd - Date.now()) / 1000)))
        tick()
        const id = setInterval(tick, 500)
        return () => clearInterval(id)
    }, [clockEnd])

    useEffect(() => {
        const stableMemberId = memberIdRef.current
        if (secondsLeft !== 0 || !draftId || !stableMemberId || picking) return
        if (autoPickFiredRef.current || state?.nextPick?.memberId !== stableMemberId) return

        autoPickFiredRef.current = true
        ;(async () => {
            setPicking(true)
            try {
                await autoPickBest(draftId, stableMemberId)
                setQuery('')
                await Promise.all([load(), loadProspects()])
            } catch (e) {
                Alert.alert('Auto-pick failed', getErrorMessage(e))
            } finally {
                setPicking(false)
            }
        })()
    }, [secondsLeft, draftId, picking, state?.nextPick?.memberId, load, loadProspects])

    const draftCompleted = state?.draft.status === 'completed'
    useEffect(() => {
        const stableMemberId = memberIdRef.current ?? memberId
        if (!draftCompleted || !stableMemberId || !leagueId || draftEndCheckedRef.current) return

        draftEndCheckedRef.current = true
        ;(async () => {
            try {
                const roster = await getRoster(stableMemberId, leagueId)
                const active = roster.filter((player) => !player.is_on_ir && !player.is_on_taxi)
                const excess = active.length - rosterSize
                if (excess > 0) {
                    setTrimOverflow({ excess, dropList: active })
                } else if (draftId) {
                    setTrimOverflow(null)
                    await activateRookieDraftLeague(draftId)
                    await load()
                }
            } catch (e) {
                console.error('[rookie-draft] post-draft roster check:', e)
            }
        })()
    }, [draftCompleted, draftId, leagueId, rosterSize, memberId, load])

    async function handleTrimDrop(rosterPlayerId: string) {
        if (trimmingId) return
        setTrimmingId(rosterPlayerId)
        try {
            await dropPlayer(rosterPlayerId)
            const stableMemberId = memberIdRef.current ?? memberId
            if (stableMemberId && leagueId) {
                const roster = await getRoster(stableMemberId, leagueId)
                const active = roster.filter((player) => !player.is_on_ir && !player.is_on_taxi)
                const excess = active.length - rosterSize
                setTrimOverflow(excess <= 0 ? null : { excess, dropList: active })
                if (excess <= 0 && draftId) {
                    await activateRookieDraftLeague(draftId)
                    await load()
                }
            } else {
                setTrimOverflow(null)
            }
        } catch (e) {
            Alert.alert('Error', getErrorMessage(e) ?? 'Failed to drop player')
        } finally {
            setTrimmingId(null)
        }
    }

    async function handlePick(player: RookieProspect) {
        const stableMemberId = memberIdRef.current
        if (!draftId || !stableMemberId || picking) return

        setPickError(null)
        setPicking(true)
        try {
            const result = await makeSnakePick(draftId, stableMemberId, player.id)
            setQuery('')
            await Promise.all([load(), loadProspects()])

            if (result?.rosterOverflow) {
                let newRosterPlayerId: string | null = null
                let dropList: RosterPlayer[] = []
                if (leagueId) {
                    try {
                        const roster = await getRoster(stableMemberId, leagueId)
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
            setPickError(getErrorMessage(e) ?? 'Pick failed')
        } finally {
            setPicking(false)
        }
    }

    async function resolveByTaxi() {
        if (!rosterOverflow?.newRosterPlayerId || resolvingOverflow) return
        setResolvingOverflow(true)
        try {
            await toggleTaxi(rosterOverflow.newRosterPlayerId, true)
            setRosterOverflow(null)
            if (draftId) {
                await activateRookieDraftLeague(draftId)
                await load()
            }
        } catch (e) {
            Alert.alert('Error', getErrorMessage(e) ?? 'Failed to move to taxi')
        } finally {
            setResolvingOverflow(false)
        }
    }

    async function resolveByDrop(rosterPlayerId: string) {
        if (resolvingOverflow) return
        setResolvingOverflow(true)
        try {
            await dropPlayer(rosterPlayerId)
            setRosterOverflow(null)
            if (draftId) {
                await activateRookieDraftLeague(draftId)
                await load()
            }
        } catch (e) {
            Alert.alert('Error', getErrorMessage(e) ?? 'Failed to drop player')
        } finally {
            setResolvingOverflow(false)
        }
    }

    return {
        state,
        loading,
        query,
        setQuery,
        prospects,
        prospectsLoading,
        picking,
        activeTab,
        setActiveTab,
        secondsLeft,
        pickError,
        rosterOverflow,
        rosterForDrop,
        resolvingOverflow,
        trimOverflow,
        trimmingId,
        memberId: memberId ?? memberIdRef.current,
        handleTrimDrop,
        handlePick,
        resolveByTaxi,
        resolveByDrop,
    }
}

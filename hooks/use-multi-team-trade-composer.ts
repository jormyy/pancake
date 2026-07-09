import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getRoster, type RosterPlayer } from '@/lib/roster'
import { EMPTY_AVG_MAP, EMPTY_STATS_MAP, getRosterStatsMaps } from '@/lib/roster-stats'
import { getPicksForMember, type MultiTeamTradeItemPayload, type Trade, type TradePickItem } from '@/lib/trades'
import { getErrorMessage } from '@/lib/alert'

export type TradeComposerMember = {
    id: string
    team_name: string | null
}

export const isTradeableRosterPlayer = (player: RosterPlayer) => !player.is_on_ir && !player.is_on_taxi

type UseMultiTeamTradeComposerArgs = {
    enabled: boolean
    myMemberId: string
    leagueId: string
    myTeamName: string
    members: TradeComposerMember[]
    faabEnabled: boolean
}

export function useMultiTeamTradeComposer({
    enabled,
    myMemberId,
    leagueId,
    myTeamName,
    members,
    faabEnabled,
}: UseMultiTeamTradeComposerArgs) {
    const [selectedParticipantIds, setSelectedParticipantIds] = useState<Set<string>>(new Set())
    const [participantRosters, setParticipantRosters] = useState<Record<string, RosterPlayer[]>>({})
    const [participantPicks, setParticipantPicks] = useState<Record<string, TradePickItem[]>>({})
    const [participantPlayerIds, setParticipantPlayerIds] = useState<Record<string, Set<string>>>({})
    const [participantPickIds, setParticipantPickIds] = useState<Record<string, Set<string>>>({})
    const [participantDestinationIds, setParticipantDestinationIds] = useState<Record<string, string>>({})
    const [participantPlayerDestinationIds, setParticipantPlayerDestinationIds] = useState<Record<string, Record<string, string>>>({})
    const [participantPickDestinationIds, setParticipantPickDestinationIds] = useState<Record<string, Record<string, string>>>({})
    const [participantFaabInputs, setParticipantFaabInputs] = useState<Record<string, string>>({})
    const [avgMap, setAvgMap] = useState(EMPTY_AVG_MAP)
    const [avgStatsMap, setAvgStatsMap] = useState(EMPTY_STATS_MAP)
    const [rosterLoading, setRosterLoading] = useState(false)
    const [rosterError, setRosterError] = useState<string | null>(null)
    const [retryToken, setRetryToken] = useState(0)
    const rosterLoadSeqRef = useRef(0)

    const selectedParticipantKey = useMemo(
        () => [...selectedParticipantIds].sort().join(','),
        [selectedParticipantIds],
    )
    const participantIds = useMemo(
        () => [myMemberId, ...members.filter((member) => selectedParticipantIds.has(member.id)).map((member) => member.id)].filter(Boolean),
        [members, myMemberId, selectedParticipantIds],
    )

    const reset = useCallback(() => {
        setSelectedParticipantIds(new Set())
        setParticipantRosters({})
        setParticipantPicks({})
        setParticipantPlayerIds({})
        setParticipantPickIds({})
        setParticipantDestinationIds({})
        setParticipantPlayerDestinationIds({})
        setParticipantPickDestinationIds({})
        setParticipantFaabInputs({})
        setAvgMap(EMPTY_AVG_MAP)
        setAvgStatsMap(EMPTY_STATS_MAP)
        setRosterError(null)
        setRosterLoading(false)
    }, [])

    const defaultDestinationFor = useCallback((memberId: string, ids = participantIds) => {
        if (ids.length < 2) return ''
        const currentIndex = ids.indexOf(memberId)
        if (currentIndex < 0) return ids.find((id) => id !== memberId) ?? ''
        return ids[(currentIndex + 1) % ids.length] ?? ''
    }, [participantIds])

    const destinationFor = useCallback((memberId: string, ids = participantIds) => {
        const current = participantDestinationIds[memberId]
        if (current && current !== memberId && ids.includes(current)) return current
        return defaultDestinationFor(memberId, ids)
    }, [defaultDestinationFor, participantDestinationIds, participantIds])

    const itemDestinationFor = useCallback((
        memberId: string,
        itemId: string,
        destinations: Record<string, Record<string, string>>,
        ids = participantIds,
    ) => {
        const destination = destinations[memberId]?.[itemId]
        if (destination && destination !== memberId && ids.includes(destination)) return destination
        return destinationFor(memberId, ids)
    }, [destinationFor, participantIds])

    const toggleParticipant = useCallback((memberId: string) => {
        setSelectedParticipantIds((prev) => {
            const next = new Set(prev)
            if (next.has(memberId)) next.delete(memberId)
            else next.add(memberId)
            return next
        })
    }, [])

    const toggleParticipantPlayer = useCallback((memberId: string, playerId: string) => {
        const wasSelected = participantPlayerIds[memberId]?.has(playerId) ?? false
        setParticipantPlayerIds((prev) => {
            const current = new Set(prev[memberId] ?? [])
            if (current.has(playerId)) current.delete(playerId)
            else current.add(playerId)
            return { ...prev, [memberId]: current }
        })
        setParticipantPlayerDestinationIds((prev) => {
            const current = { ...(prev[memberId] ?? {}) }
            if (wasSelected) delete current[playerId]
            else current[playerId] = destinationFor(memberId)
            return { ...prev, [memberId]: current }
        })
    }, [destinationFor, participantPlayerIds])

    const toggleParticipantPick = useCallback((memberId: string, pickId: string) => {
        const wasSelected = participantPickIds[memberId]?.has(pickId) ?? false
        setParticipantPickIds((prev) => {
            const current = new Set(prev[memberId] ?? [])
            if (current.has(pickId)) current.delete(pickId)
            else current.add(pickId)
            return { ...prev, [memberId]: current }
        })
        setParticipantPickDestinationIds((prev) => {
            const current = { ...(prev[memberId] ?? {}) }
            if (wasSelected) delete current[pickId]
            else current[pickId] = destinationFor(memberId)
            return { ...prev, [memberId]: current }
        })
    }, [destinationFor, participantPickIds])

    const setParticipantFaab = useCallback((memberId: string, value: string) => {
        if (!/^\d*$/.test(value)) return
        setParticipantFaabInputs((prev) => ({ ...prev, [memberId]: value }))
    }, [])

    const prefillFromTrade = useCallback((trade: Trade, actorMemberId = myMemberId) => {
        const participantIdsFromTrade = trade.participants.length > 0
            ? trade.participants.map((participant) => participant.memberId)
            : [trade.proposerMemberId, trade.recipientMemberId].filter(Boolean)
        const selectedIds = participantIdsFromTrade.filter((memberId) => memberId !== actorMemberId)
        const nextPlayerIds: Record<string, Set<string>> = {}
        const nextPickIds: Record<string, Set<string>> = {}
        const nextPlayerDestinations: Record<string, Record<string, string>> = {}
        const nextPickDestinations: Record<string, Record<string, string>> = {}
        const nextFaabInputs: Record<string, string> = {}
        const nextDefaultDestinations: Record<string, string> = {}

        setSelectedParticipantIds(new Set(selectedIds))

        for (const item of trade.routedItems) {
            const fromMemberId = item.fromMemberId
            const toMemberId = item.toMemberId
            if (!fromMemberId || !toMemberId || fromMemberId === toMemberId) continue

            nextDefaultDestinations[fromMemberId] ??= toMemberId

            if (item.kind === 'player') {
                nextPlayerIds[fromMemberId] ??= new Set()
                nextPlayerDestinations[fromMemberId] ??= {}
                nextPlayerIds[fromMemberId].add(item.playerId)
                nextPlayerDestinations[fromMemberId][item.playerId] = toMemberId
            } else if (item.kind === 'pick') {
                nextPickIds[fromMemberId] ??= new Set()
                nextPickDestinations[fromMemberId] ??= {}
                nextPickIds[fromMemberId].add(item.pickId)
                nextPickDestinations[fromMemberId][item.pickId] = toMemberId
            } else if (item.kind === 'faab') {
                nextFaabInputs[fromMemberId] = String((parseInt(nextFaabInputs[fromMemberId] ?? '0', 10) || 0) + item.amount)
            }
        }

        setParticipantPlayerIds(nextPlayerIds)
        setParticipantPickIds(nextPickIds)
        setParticipantPlayerDestinationIds(nextPlayerDestinations)
        setParticipantPickDestinationIds(nextPickDestinations)
        setParticipantFaabInputs(nextFaabInputs)
        setParticipantDestinationIds(nextDefaultDestinations)
    }, [myMemberId])

    const setParticipantDestination = useCallback((memberId: string, toMemberId: string) => {
        if (memberId === toMemberId || !participantIds.includes(memberId) || !participantIds.includes(toMemberId)) return
        setParticipantDestinationIds((prev) => ({ ...prev, [memberId]: toMemberId }))
    }, [participantIds])

    const setParticipantPlayerDestination = useCallback((memberId: string, playerId: string, toMemberId: string) => {
        if (
            memberId === toMemberId ||
            !participantIds.includes(memberId) ||
            !participantIds.includes(toMemberId) ||
            !participantPlayerIds[memberId]?.has(playerId)
        ) {
            return
        }
        setParticipantPlayerDestinationIds((prev) => ({
            ...prev,
            [memberId]: { ...(prev[memberId] ?? {}), [playerId]: toMemberId },
        }))
    }, [participantIds, participantPlayerIds])

    const setParticipantPickDestination = useCallback((memberId: string, pickId: string, toMemberId: string) => {
        if (
            memberId === toMemberId ||
            !participantIds.includes(memberId) ||
            !participantIds.includes(toMemberId) ||
            !participantPickIds[memberId]?.has(pickId)
        ) {
            return
        }
        setParticipantPickDestinationIds((prev) => ({
            ...prev,
            [memberId]: { ...(prev[memberId] ?? {}), [pickId]: toMemberId },
        }))
    }, [participantIds, participantPickIds])

    const participantName = useCallback((memberId: string): string => {
        if (memberId === myMemberId) return myTeamName
        return members.find((member) => member.id === memberId)?.team_name ?? 'Unnamed'
    }, [members, myMemberId, myTeamName])

    const buildMultiTeamItems = useCallback((ids = participantIds): MultiTeamTradeItemPayload[] => (
        ids.flatMap((memberId) => {
            const toMemberId = destinationFor(memberId, ids)
            if (!toMemberId || toMemberId === memberId) return []

            const playerItems = [...(participantPlayerIds[memberId] ?? new Set<string>())].map((playerId) => ({
                fromMemberId: memberId,
                toMemberId: itemDestinationFor(memberId, playerId, participantPlayerDestinationIds, ids),
                playerId,
            }))
            const pickItems = [...(participantPickIds[memberId] ?? new Set<string>())].map((pickId) => ({
                fromMemberId: memberId,
                toMemberId: itemDestinationFor(memberId, pickId, participantPickDestinationIds, ids),
                pickId,
            }))
            const faabAmount = parseInt(participantFaabInputs[memberId] || '0', 10) || 0
            const faabItems = faabEnabled && faabAmount > 0
                ? [{ fromMemberId: memberId, toMemberId, faabAmount }]
                : []
            return [...playerItems, ...pickItems, ...faabItems]
        })
    ), [
        destinationFor,
        faabEnabled,
        itemDestinationFor,
        participantFaabInputs,
        participantIds,
        participantPickDestinationIds,
        participantPickIds,
        participantPlayerDestinationIds,
        participantPlayerIds,
    ])

    const retry = useCallback(() => setRetryToken((value) => value + 1), [])

    useEffect(() => {
        if (!enabled) return

        setParticipantDestinationIds((prev) => {
            const next: Record<string, string> = {}
            let changed = Object.keys(prev).length !== participantIds.length

            for (const memberId of participantIds) {
                const options = participantIds.filter((id) => id !== memberId)
                if (options.length === 0) continue

                const current = prev[memberId]
                next[memberId] = current && options.includes(current)
                    ? current
                    : defaultDestinationFor(memberId, participantIds)
                if (prev[memberId] !== next[memberId]) changed = true
            }

            return changed ? next : prev
        })
    }, [defaultDestinationFor, enabled, participantIds])

    useEffect(() => {
        if (!enabled) return
        const validParticipantIds = new Set(participantIds)

        setParticipantPlayerIds((prev) => {
            const next: Record<string, Set<string>> = {}
            let changed = Object.keys(prev).length !== participantIds.length
            for (const memberId of participantIds) {
                next[memberId] = prev[memberId] ?? new Set()
                if (prev[memberId] !== next[memberId]) changed = true
            }
            return changed ? next : prev
        })
        setParticipantPickIds((prev) => {
            const next: Record<string, Set<string>> = {}
            let changed = Object.keys(prev).length !== participantIds.length
            for (const memberId of participantIds) {
                next[memberId] = prev[memberId] ?? new Set()
                if (prev[memberId] !== next[memberId]) changed = true
            }
            return changed ? next : prev
        })
        setParticipantPlayerDestinationIds((prev) => {
            const next: Record<string, Record<string, string>> = {}
            let changed = Object.keys(prev).length !== participantIds.length
            for (const memberId of participantIds) {
                const selected = participantPlayerIds[memberId] ?? new Set()
                const destinations = prev[memberId] ?? {}
                const current: Record<string, string> = {}
                for (const playerId of selected) {
                    const destination = destinations[playerId]
                    current[playerId] = destination && validParticipantIds.has(destination) && destination !== memberId
                        ? destination
                        : destinationFor(memberId)
                    if (destinations[playerId] !== current[playerId]) changed = true
                }
                next[memberId] = current
            }
            return changed ? next : prev
        })
        setParticipantPickDestinationIds((prev) => {
            const next: Record<string, Record<string, string>> = {}
            let changed = Object.keys(prev).length !== participantIds.length
            for (const memberId of participantIds) {
                const selected = participantPickIds[memberId] ?? new Set()
                const destinations = prev[memberId] ?? {}
                const current: Record<string, string> = {}
                for (const pickId of selected) {
                    const destination = destinations[pickId]
                    current[pickId] = destination && validParticipantIds.has(destination) && destination !== memberId
                        ? destination
                        : destinationFor(memberId)
                    if (destinations[pickId] !== current[pickId]) changed = true
                }
                next[memberId] = current
            }
            return changed ? next : prev
        })
    }, [destinationFor, enabled, participantIds, participantPickIds, participantPlayerIds])

    useEffect(() => {
        if (!enabled || !leagueId || !myMemberId) {
            if (!enabled) setRosterLoading(false)
            return
        }

        const requestId = ++rosterLoadSeqRef.current
        setRosterLoading(true)
        setRosterError(null)

        async function loadParticipantAssets() {
            try {
                const rows = await Promise.all(participantIds.map(async (memberId) => {
                    const [roster, picks] = await Promise.all([
                        getRoster(memberId, leagueId),
                        getPicksForMember(memberId, leagueId),
                    ])
                    return {
                        memberId,
                        roster: roster.filter(isTradeableRosterPlayer),
                        picks,
                    }
                }))
                if (rosterLoadSeqRef.current !== requestId) return

                const nextRosters: Record<string, RosterPlayer[]> = {}
                const nextPicks: Record<string, TradePickItem[]> = {}
                for (const row of rows) {
                    nextRosters[row.memberId] = row.roster
                    nextPicks[row.memberId] = row.picks
                }
                const stats = await getRosterStatsMaps(
                    rows.flatMap((row) => row.roster.map((player) => player.players.id)),
                    leagueId,
                )
                if (rosterLoadSeqRef.current !== requestId) return
                setParticipantRosters(nextRosters)
                setParticipantPicks(nextPicks)
                setAvgMap(stats.avgMap)
                setAvgStatsMap(stats.avgStatsMap)
            } catch (error) {
                if (rosterLoadSeqRef.current !== requestId) return
                console.error(error)
                setRosterError(getErrorMessage(error) ?? 'Unknown error')
            } finally {
                if (rosterLoadSeqRef.current === requestId) setRosterLoading(false)
            }
        }

        loadParticipantAssets()
    }, [enabled, leagueId, myMemberId, participantIds, retryToken, selectedParticipantKey])

    return {
        selectedParticipantIds,
        participantIds,
        participantRosters,
        participantPicks,
        participantPlayerIds,
        participantPickIds,
        participantDestinationIds,
        participantPlayerDestinationIds,
        participantPickDestinationIds,
        participantFaabInputs,
        avgMap,
        avgStatsMap,
        rosterLoading,
        rosterError,
        reset,
        prefillFromTrade,
        retry,
        toggleParticipant,
        toggleParticipantPlayer,
        toggleParticipantPick,
        setParticipantDestination,
        setParticipantPlayerDestination,
        setParticipantPickDestination,
        setParticipantFaab,
        participantName,
        buildMultiTeamItems,
    }
}

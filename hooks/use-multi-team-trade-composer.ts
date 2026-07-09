import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getRoster, type RosterPlayer } from '@/lib/roster'
import { EMPTY_AVG_MAP, EMPTY_STATS_MAP, getRosterStatsMaps } from '@/lib/roster-stats'
import { getPicksForMember, type MultiTeamTradeItemPayload, type TradePickItem } from '@/lib/trades'
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
        setParticipantFaabInputs({})
        setAvgMap(EMPTY_AVG_MAP)
        setAvgStatsMap(EMPTY_STATS_MAP)
        setRosterError(null)
        setRosterLoading(false)
    }, [])

    const toggleParticipant = useCallback((memberId: string) => {
        setSelectedParticipantIds((prev) => {
            const next = new Set(prev)
            if (next.has(memberId)) next.delete(memberId)
            else next.add(memberId)
            return next
        })
    }, [])

    const toggleParticipantPlayer = useCallback((memberId: string, playerId: string) => {
        setParticipantPlayerIds((prev) => {
            const current = new Set(prev[memberId] ?? [])
            if (current.has(playerId)) current.delete(playerId)
            else current.add(playerId)
            return { ...prev, [memberId]: current }
        })
    }, [])

    const toggleParticipantPick = useCallback((memberId: string, pickId: string) => {
        setParticipantPickIds((prev) => {
            const current = new Set(prev[memberId] ?? [])
            if (current.has(pickId)) current.delete(pickId)
            else current.add(pickId)
            return { ...prev, [memberId]: current }
        })
    }, [])

    const setParticipantFaab = useCallback((memberId: string, value: string) => {
        if (!/^\d*$/.test(value)) return
        setParticipantFaabInputs((prev) => ({ ...prev, [memberId]: value }))
    }, [])

    const setParticipantDestination = useCallback((memberId: string, toMemberId: string) => {
        if (memberId === toMemberId || !participantIds.includes(memberId) || !participantIds.includes(toMemberId)) return
        setParticipantDestinationIds((prev) => ({ ...prev, [memberId]: toMemberId }))
    }, [participantIds])

    const participantName = useCallback((memberId: string): string => {
        if (memberId === myMemberId) return myTeamName
        return members.find((member) => member.id === memberId)?.team_name ?? 'Unnamed'
    }, [members, myMemberId, myTeamName])

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

    const buildMultiTeamItems = useCallback((ids = participantIds): MultiTeamTradeItemPayload[] => (
        ids.flatMap((memberId) => {
            const toMemberId = destinationFor(memberId, ids)
            if (!toMemberId || toMemberId === memberId) return []

            const playerItems = [...(participantPlayerIds[memberId] ?? new Set<string>())].map((playerId) => ({
                fromMemberId: memberId,
                toMemberId,
                playerId,
            }))
            const pickItems = [...(participantPickIds[memberId] ?? new Set<string>())].map((pickId) => ({
                fromMemberId: memberId,
                toMemberId,
                pickId,
            }))
            const faabAmount = parseInt(participantFaabInputs[memberId] || '0', 10) || 0
            const faabItems = faabEnabled && faabAmount > 0
                ? [{ fromMemberId: memberId, toMemberId, faabAmount }]
                : []
            return [...playerItems, ...pickItems, ...faabItems]
        })
    ), [destinationFor, faabEnabled, participantFaabInputs, participantIds, participantPickIds, participantPlayerIds])

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
        participantFaabInputs,
        avgMap,
        avgStatsMap,
        rosterLoading,
        rosterError,
        reset,
        retry,
        toggleParticipant,
        toggleParticipantPlayer,
        toggleParticipantPick,
        setParticipantDestination,
        setParticipantFaab,
        participantName,
        buildMultiTeamItems,
    }
}

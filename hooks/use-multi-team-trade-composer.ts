import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { getRoster, type RosterPlayer } from '@/lib/roster'
import { EMPTY_AVG_MAP, EMPTY_STATS_MAP, getRosterStatsMaps } from '@/lib/roster-stats'
import { getPicksForMember, type Trade, type TradePickItem } from '@/lib/trades'
import { getErrorMessage } from '@/lib/alert'
import {
    buildMultiTeamTradeItems,
    createMultiTeamTradeState,
    explicitAssetDestinations,
    multiTeamTradeReducer,
    multiTeamTradeStateFromTrade,
    selectedAssetIds,
} from '@/lib/multi-team-trade-state'

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
    const [composerState, dispatch] = useReducer(multiTeamTradeReducer, myMemberId, createMultiTeamTradeState)
    const [participantRosters, setParticipantRosters] = useState<Record<string, RosterPlayer[]>>({})
    const [participantPicks, setParticipantPicks] = useState<Record<string, TradePickItem[]>>({})
    const [avgMap, setAvgMap] = useState(EMPTY_AVG_MAP)
    const [avgStatsMap, setAvgStatsMap] = useState(EMPTY_STATS_MAP)
    const [rosterLoading, setRosterLoading] = useState(false)
    const [rosterError, setRosterError] = useState<string | null>(null)
    const [retryToken, setRetryToken] = useState(0)
    const rosterLoadSeqRef = useRef(0)

    const selectedParticipantIds = composerState.selectedParticipantIds
    const participantIds = composerState.participantOrder
    const selectedParticipantKey = participantIds.join(',')
    const participantPlayerIds = useMemo(() => selectedAssetIds(composerState, 'player'), [composerState])
    const participantPickIds = useMemo(() => selectedAssetIds(composerState, 'pick'), [composerState])
    const participantDestinationIds = useMemo(() => Object.fromEntries(
        participantIds.map((memberId) => [memberId, composerState.participants[memberId].defaultDestinationId]),
    ), [composerState, participantIds])
    const participantPlayerDestinationIds = useMemo(
        () => explicitAssetDestinations(composerState, 'player'),
        [composerState],
    )
    const participantPickDestinationIds = useMemo(
        () => explicitAssetDestinations(composerState, 'pick'),
        [composerState],
    )
    const participantFaabInputs = useMemo(() => Object.fromEntries(
        participantIds.map((memberId) => [memberId, composerState.participants[memberId].faabInput]),
    ), [composerState, participantIds])

    const reset = useCallback(() => {
        dispatch({ type: 'reset', actorMemberId: myMemberId })
        setParticipantRosters({})
        setParticipantPicks({})
        setAvgMap(EMPTY_AVG_MAP)
        setAvgStatsMap(EMPTY_STATS_MAP)
        setRosterError(null)
        setRosterLoading(false)
    }, [myMemberId])

    const toggleParticipant = useCallback((memberId: string) => {
        dispatch({
            type: 'toggle-participant',
            memberId,
            actorMemberId: myMemberId,
            availableMemberIds: members.map((member) => member.id),
        })
    }, [members, myMemberId])

    const toggleParticipantPlayer = useCallback((memberId: string, playerId: string) => {
        dispatch({ type: 'toggle-asset', asset: 'player', memberId, assetId: playerId })
    }, [])

    const toggleParticipantPick = useCallback((memberId: string, pickId: string) => {
        dispatch({ type: 'toggle-asset', asset: 'pick', memberId, assetId: pickId })
    }, [])

    const setParticipantFaab = useCallback((memberId: string, value: string) => {
        dispatch({ type: 'set-faab', memberId, value })
    }, [])

    const prefillFromTrade = useCallback((trade: Trade, actorMemberId = myMemberId) => {
        dispatch({ type: 'prefill', state: multiTeamTradeStateFromTrade(trade, actorMemberId) })
    }, [myMemberId])

    const setParticipantDestination = useCallback((memberId: string, toMemberId: string) => {
        dispatch({ type: 'set-default-destination', memberId, toMemberId })
    }, [])

    const setParticipantPlayerDestination = useCallback((memberId: string, playerId: string, toMemberId: string) => {
        dispatch({ type: 'set-asset-destination', asset: 'player', memberId, assetId: playerId, toMemberId })
    }, [])

    const setParticipantPickDestination = useCallback((memberId: string, pickId: string, toMemberId: string) => {
        dispatch({ type: 'set-asset-destination', asset: 'pick', memberId, assetId: pickId, toMemberId })
    }, [])

    const participantName = useCallback((memberId: string): string => {
        if (memberId === myMemberId) return myTeamName
        return members.find((member) => member.id === memberId)?.team_name ?? 'Unnamed'
    }, [members, myMemberId, myTeamName])

    const buildMultiTeamItems = useCallback(
        () => buildMultiTeamTradeItems(composerState, faabEnabled),
        [composerState, faabEnabled],
    )

    const retry = useCallback(() => setRetryToken((value) => value + 1), [])

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

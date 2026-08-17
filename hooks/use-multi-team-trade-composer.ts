import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { getRostersForMembers, type RosterPlayer } from '@/lib/roster'
import { EMPTY_AVG_MAP, EMPTY_STATS_MAP, getRosterStatsMaps } from '@/lib/roster-stats'
import { getPicksForMembers, type Trade, type TradePickItem } from '@/lib/trades'
import { getErrorMessage } from '@/lib/alert'
import {
    buildMultiTeamTradeItems,
    createMultiTeamTradeState,
    multiTeamTradeReducer,
    multiTeamTradeStateFromTrade,
    multiTeamTradeStateFromItems,
    resolvedDestination,
} from '@/lib/multi-team-trade-state'
import { isTradeableRosterPlayer } from '@/lib/trade-assets'
import type { TradeComposerMember, TradeParticipantView } from '@/lib/trade-ui-model'

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
    const [participantAssets, setParticipantAssets] = useState<{
        rosters: Record<string, RosterPlayer[]>
        picks: Record<string, TradePickItem[]>
    }>({ rosters: {}, picks: {} })
    const participantRosters = participantAssets.rosters
    const participantPicks = participantAssets.picks
    const [avgMap, setAvgMap] = useState(EMPTY_AVG_MAP)
    const [avgStatsMap, setAvgStatsMap] = useState(EMPTY_STATS_MAP)
    const [rosterLoading, setRosterLoading] = useState(false)
    const [rosterError, setRosterError] = useState<string | null>(null)
    const [loadedParticipantKey, setLoadedParticipantKey] = useState('')
    const [retryToken, setRetryToken] = useState(0)
    const rosterLoadSeqRef = useRef(0)
    const statsLoadSeqRef = useRef(0)

    const participantIds = composerState.participantOrder
    const selectedParticipantIds = useMemo(
        () => new Set(participantIds.filter((memberId) => memberId !== myMemberId)),
        [myMemberId, participantIds],
    )
    const selectedParticipantKey = participantIds.join(',')
    const participantViews = useMemo<TradeParticipantView[]>(() => participantIds.map((memberId) => {
        const participant = composerState.participants[memberId]
        const selectedPlayerIds = new Set(Object.keys(participant.playerDestinations))
        const selectedPickIds = new Set(Object.keys(participant.pickDestinations))
        return {
            memberId,
            destinationIds: participantIds.filter((participantId) => participantId !== memberId),
            defaultDestinationId: participant.defaultDestinationId,
            roster: participantRosters[memberId] ?? [],
            picks: participantPicks[memberId] ?? [],
            selectedPlayerIds,
            selectedPickIds,
            playerDestinationIds: Object.fromEntries([...selectedPlayerIds].map((playerId) => [
                playerId,
                resolvedDestination(composerState, memberId, 'player', playerId),
            ])),
            pickDestinationIds: Object.fromEntries([...selectedPickIds].map((pickId) => [
                pickId,
                resolvedDestination(composerState, memberId, 'pick', pickId),
            ])),
            faabInputs: participant.faabInputs,
        }
    }), [composerState, participantIds, participantPicks, participantRosters])

    const reset = useCallback(() => {
        rosterLoadSeqRef.current += 1
        statsLoadSeqRef.current += 1
        dispatch({ type: 'reset', actorMemberId: myMemberId })
        setParticipantAssets({ rosters: {}, picks: {} })
        setAvgMap(EMPTY_AVG_MAP)
        setAvgStatsMap(EMPTY_STATS_MAP)
        setRosterError(null)
        setLoadedParticipantKey('')
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

    const setParticipantIds = useCallback((participantIds: string[]) => {
        dispatch({ type: 'set-participants', actorMemberId: myMemberId, participantIds })
    }, [myMemberId])

    const toggleParticipantPlayer = useCallback((memberId: string, playerId: string) => {
        dispatch({ type: 'toggle-asset', asset: 'player', memberId, assetId: playerId })
    }, [])

    const toggleParticipantPick = useCallback((memberId: string, pickId: string) => {
        dispatch({ type: 'toggle-asset', asset: 'pick', memberId, assetId: pickId })
    }, [])

    const selectParticipantAsset = useCallback((
        memberId: string,
        asset: 'player' | 'pick',
        assetId: string,
    ) => {
        dispatch({ type: 'select-asset', asset, memberId, assetId })
    }, [])

    const setParticipantFaab = useCallback((memberId: string, toMemberId: string, value: string) => {
        dispatch({ type: 'set-faab', memberId, toMemberId, value })
    }, [])

    const prefillFromTrade = useCallback((trade: Trade, actorMemberId = myMemberId) => {
        dispatch({ type: 'prefill', state: multiTeamTradeStateFromTrade(trade, actorMemberId) })
    }, [myMemberId])

    const prefillFromItems = useCallback((participantIds: string[], items: ReturnType<typeof buildMultiTeamTradeItems>) => {
        dispatch({ type: 'prefill', state: multiTeamTradeStateFromItems(myMemberId, participantIds, items) })
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

    const retry = useCallback(() => {
        rosterLoadSeqRef.current += 1
        statsLoadSeqRef.current += 1
        setParticipantAssets({ rosters: {}, picks: {} })
        setAvgMap(EMPTY_AVG_MAP)
        setAvgStatsMap(EMPTY_STATS_MAP)
        setRetryToken((value) => value + 1)
    }, [])

    useEffect(() => {
        reset()
    }, [leagueId, myMemberId, reset])

    useEffect(() => {
        const activeParticipants = new Set(participantIds)
        setParticipantAssets((current) => ({
            rosters: Object.fromEntries(
                Object.entries(current.rosters).filter(([memberId]) => activeParticipants.has(memberId)),
            ),
            picks: Object.fromEntries(
                Object.entries(current.picks).filter(([memberId]) => activeParticipants.has(memberId)),
            ),
        }))
    }, [participantIds])

    useEffect(() => {
        const requestId = ++rosterLoadSeqRef.current
        if (!enabled || !leagueId || !myMemberId || participantIds[0] !== myMemberId) {
            setRosterLoading(false)
            return
        }

        const missingParticipantIds = participantIds.filter((memberId) =>
            !(memberId in participantRosters) || !(memberId in participantPicks))
        if (missingParticipantIds.length === 0) {
            setLoadedParticipantKey(selectedParticipantKey)
            setRosterLoading(false)
            return
        }

        setRosterLoading(true)
        setRosterError(null)

        async function loadParticipantAssets() {
            try {
                const [rosters, picks] = await Promise.all([
                    getRostersForMembers(missingParticipantIds, leagueId),
                    getPicksForMembers(missingParticipantIds, leagueId),
                ])
                if (rosterLoadSeqRef.current !== requestId) return

                const nextRosters = Object.fromEntries(missingParticipantIds.map((memberId) => [
                    memberId,
                    (rosters[memberId] ?? []).filter(isTradeableRosterPlayer),
                ]))
                setParticipantAssets((current) => ({
                    rosters: { ...current.rosters, ...nextRosters },
                    picks: { ...current.picks, ...picks },
                }))
                setLoadedParticipantKey(selectedParticipantKey)
                setRosterLoading(false)
            } catch (error) {
                if (rosterLoadSeqRef.current !== requestId) return
                console.error(error)
                setRosterError(getErrorMessage(error) ?? 'Unknown error')
            } finally {
                if (rosterLoadSeqRef.current === requestId) setRosterLoading(false)
            }
        }

        loadParticipantAssets()
        return () => {
            if (rosterLoadSeqRef.current === requestId) rosterLoadSeqRef.current += 1
        }
    }, [enabled, leagueId, myMemberId, participantIds, participantPicks, participantRosters, retryToken, selectedParticipantKey])

    useEffect(() => {
        const requestId = ++statsLoadSeqRef.current
        setAvgMap(EMPTY_AVG_MAP)
        setAvgStatsMap(EMPTY_STATS_MAP)

        const ownsCompleteSnapshot = enabled && leagueId && myMemberId &&
            participantIds[0] === myMemberId && loadedParticipantKey === selectedParticipantKey &&
            participantIds.every((memberId) => memberId in participantRosters && memberId in participantPicks)
        if (!ownsCompleteSnapshot) return

        async function loadParticipantStats() {
            try {
                const stats = await getRosterStatsMaps(
                    participantIds.flatMap((memberId) =>
                        (participantRosters[memberId] ?? []).map((player) => player.players.id)),
                    leagueId,
                )
                if (statsLoadSeqRef.current !== requestId) return
                setAvgMap(stats.avgMap)
                setAvgStatsMap(stats.avgStatsMap)
            } catch (error) {
                if (statsLoadSeqRef.current === requestId) {
                    console.warn('Could not load optional trade player averages.', error)
                }
            }
        }

        void loadParticipantStats()
        return () => {
            if (statsLoadSeqRef.current === requestId) statsLoadSeqRef.current += 1
        }
    }, [enabled, leagueId, loadedParticipantKey, myMemberId, participantIds, participantPicks,
        participantRosters, selectedParticipantKey])

    const assetsReady = enabled && !rosterLoading && !rosterError &&
        loadedParticipantKey === selectedParticipantKey &&
        participantIds.every((memberId) => memberId in participantRosters && memberId in participantPicks)

    return {
        selectedParticipantIds,
        participantIds,
        participantRosters,
        participantPicks,
        participantViews,
        avgMap,
        avgStatsMap,
        rosterLoading,
        rosterError,
        loadedParticipantKey,
        assetsReady,
        reset,
        prefillFromTrade,
        prefillFromItems,
        retry,
        toggleParticipant,
        setParticipantIds,
        toggleParticipantPlayer,
        toggleParticipantPick,
        selectParticipantAsset,
        setParticipantDestination,
        setParticipantPlayerDestination,
        setParticipantPickDestination,
        setParticipantFaab,
        participantName,
        buildMultiTeamItems,
    }
}

import { useEffect, useMemo, useRef, useState } from 'react'
import {
    analyzeDynastyTrade,
    type DynastyStrategy,
    type DynastyTradeAnalysis,
    type DynastyTradeRoute,
} from '@pancake/core'
import { currentSeasonYear } from '@/lib/shared/season'
import {
    dynastyEngineContext,
    getDynastyDecisionInputs,
    playerAssetFromDecisionInput,
    type DynastyDecisionInput,
} from '@/lib/dynasty-decisions'
import type { TradeParticipantView } from '@/lib/trade-ui-model'
import type { Json } from '@/types/database'
import type { MultiTeamTradeItemPayload } from '@/lib/trades'

type Input = {
    enabled: boolean
    leagueId: string
    memberId: string
    scoringSettings: Json | null | undefined
    teams: number
    faabBudget: number
    strategy: DynastyStrategy
    participants: TradeParticipantView[]
    items: MultiTeamTradeItemPayload[]
}

export function useDynastyTradeAnalysis(input: Input): {
    analysis: DynastyTradeAnalysis | null
    loading: boolean
    error: string | null
} {
    const [rows, setRows] = useState<DynastyDecisionInput[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const sequence = useRef(0)
    const playerIds = useMemo(() => [...new Set(input.items.flatMap((item) =>
        item.kind === 'player' ? [item.playerId] : [],
    ))].sort(), [input.items])
    const playerKey = playerIds.join(',')

    useEffect(() => {
        const requestId = ++sequence.current
        if (!input.enabled || !input.leagueId || !input.memberId || playerIds.length === 0) {
            setRows([])
            setLoading(false)
            setError(null)
            return
        }
        setLoading(true)
        setError(null)
        void getDynastyDecisionInputs({
            leagueId: input.leagueId,
            memberId: input.memberId,
            seasonYear: currentSeasonYear(),
            playerIds,
            limit: playerIds.length,
        }).then((nextRows) => {
            if (sequence.current !== requestId) return
            setRows(nextRows)
        }).catch((cause) => {
            if (sequence.current !== requestId) return
            setError(cause instanceof Error ? cause.message : 'Could not load trade values.')
        }).finally(() => {
            if (sequence.current === requestId) setLoading(false)
        })
        return () => {
            if (sequence.current === requestId) sequence.current += 1
        }
    }, [input.enabled, input.leagueId, input.memberId, playerKey])

    const analysis = useMemo(() => {
        if (!input.enabled || input.items.length === 0) return null
        const rowByPlayer = new Map(rows.map((row) => [row.player_id, row]))
        const picks = new Map(input.participants.flatMap((participant) =>
            participant.picks.map((pick) => [pick.pickId, pick] as const),
        ))
        const rosters = new Map(input.participants.flatMap((participant) =>
            participant.roster.map((roster) => [roster.players.id, roster] as const),
        ))
        const routes = input.items.flatMap((item): DynastyTradeRoute[] => {
            if (item.kind === 'player') {
                const row = rowByPlayer.get(item.playerId)
                const roster = rosters.get(item.playerId)
                if (!row && !roster) return []
                return [{
                    fromMemberId: item.fromMemberId,
                    toMemberId: item.toMemberId,
                    asset: row ? playerAssetFromDecisionInput(row) : {
                        kind: 'player',
                        id: item.playerId,
                        label: roster?.players.display_name ?? 'Player',
                        age: null,
                        dynastyRank: null,
                        rankMovement: null,
                        healthStatus: roster?.players.injury_status ?? null,
                    },
                }]
            }
            if (item.kind === 'pick') {
                const pick = picks.get(item.pickId)
                if (!pick) return []
                return [{
                    fromMemberId: item.fromMemberId,
                    toMemberId: item.toMemberId,
                    asset: {
                        kind: 'pick',
                        id: pick.pickId,
                        label: `${pick.seasonYear} Round ${pick.round} · ${pick.originalTeamName}`,
                        seasonYear: pick.seasonYear,
                        round: pick.round,
                        slot: null,
                        teams: input.teams,
                        sources: [{ name: 'league draft picks', fetchedAt: null }],
                    },
                }]
            }
            return [{
                fromMemberId: item.fromMemberId,
                toMemberId: item.toMemberId,
                asset: {
                    kind: 'faab',
                    id: `faab:${item.fromMemberId}:${item.toMemberId}`,
                    label: `$${item.faabAmount} FAAB`,
                    amount: item.faabAmount,
                    budget: input.faabBudget,
                    freeAgentQuality: 0.5,
                    sources: [{ name: 'league FAAB settings', fetchedAt: null }],
                },
            }]
        })
        return analyzeDynastyTrade(
            dynastyEngineContext(input.leagueId, currentSeasonYear(), input.scoringSettings),
            input.strategy,
            routes,
        )
    }, [input.enabled, input.faabBudget, input.items, input.leagueId, input.participants,
        input.scoringSettings, input.strategy, input.teams, rows])

    return { analysis, loading, error }
}

import { pickLabel } from '@/lib/picks'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
    analyzeDynastyTrade,
    type DynastyTradeAnalysis,
    type DynastyTradeRoute,
} from '@pancake/core'
import { getCurrentSeason } from '@/lib/shared/season'
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
    debounceMs?: number
    leagueId: string
    memberId: string
    scoringSettings: Json | null | undefined
    teams: number
    faabBudget: number
    participants: TradeParticipantView[]
    items: MultiTeamTradeItemPayload[]
}

export function useDynastyTradeAnalysis(input: Input): {
    analysis: DynastyTradeAnalysis | null
    seasonYear: number | null
    loading: boolean
    error: string | null
} {
    const [rows, setRows] = useState<DynastyDecisionInput[]>([])
    const [seasonYear, setSeasonYear] = useState<number | null>(null)
    const [resultScope, setResultScope] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const sequence = useRef(0)
    const playerIds = useMemo(() => [...new Set(input.items.flatMap((item) =>
        item.kind === 'player' ? [item.playerId] : [],
    ))].sort(), [input.items])
    const debounceMs = input.debounceMs ?? 0
    const playerKey = playerIds.join(',')
    const scopeKey = `${input.enabled}:${input.leagueId}:${input.memberId}:${playerKey}`
    const activeScopeRef = useRef(scopeKey)
    activeScopeRef.current = scopeKey

    useEffect(() => {
        const requestId = ++sequence.current
        const scopedPlayerIds = playerKey ? playerKey.split(',') : []
        if (!input.enabled || !input.leagueId || !input.memberId) {
            setRows([])
            setSeasonYear(null)
            setLoading(false)
            setError(null)
            return
        }
        setLoading(true)
        setError(null)
        const fetchInputs = async () => {
            try {
                const season = await getCurrentSeason(input.leagueId)
                if (activeScopeRef.current !== scopeKey || sequence.current !== requestId) return
                if (!season) throw new Error('This league has no active season.')
                const nextRows = scopedPlayerIds.length > 0 ? await getDynastyDecisionInputs({
                    leagueId: input.leagueId,
                    memberId: input.memberId,
                    seasonYear: season.seasonYear,
                    playerIds: scopedPlayerIds,
                    limit: scopedPlayerIds.length,
                }) : []
                if (activeScopeRef.current !== scopeKey || sequence.current !== requestId) return
                setSeasonYear(season.seasonYear)
                setRows(nextRows)
                setResultScope(scopeKey)
            } catch (cause) {
                if (activeScopeRef.current !== scopeKey || sequence.current !== requestId) return
                setSeasonYear(null)
                setResultScope(scopeKey)
                setError(cause instanceof Error ? cause.message : 'Could not load trade values.')
            } finally {
                if (activeScopeRef.current === scopeKey && sequence.current === requestId) setLoading(false)
            }
        }
        const timer = debounceMs > 0 ? setTimeout(() => { void fetchInputs() }, debounceMs) : null
        if (!timer) void fetchInputs()
        return () => {
            if (timer) clearTimeout(timer)
            if (sequence.current === requestId) sequence.current += 1
        }
    }, [debounceMs, input.enabled, input.leagueId, input.memberId, playerKey, scopeKey])

    const result = useMemo(() => {
        if (!input.enabled || loading || error || input.items.length === 0 || seasonYear == null || resultScope !== scopeKey) return { analysis: null, error: null }
        const rowByPlayer = new Map(rows.map((row) => [row.player_id, row]))
        const picks = new Map(input.participants.flatMap((participant) =>
            participant.picks.map((pick) => [pick.pickId, pick] as const),
        ))
        const rosters = new Map(input.participants.flatMap((participant) =>
            participant.roster.map((roster) => [roster.players.id, roster] as const),
        ))
        for (const item of input.items) {
            if (item.kind === 'pick' && !picks.has(item.pickId)) {
                return { analysis: null, error: 'A selected draft pick is unavailable. Remove it to analyze the remaining routes.' }
            }
            if (item.kind === 'player' && !rowByPlayer.has(item.playerId) && !rosters.has(item.playerId)) {
                return { analysis: null, error: 'A selected player is unavailable. Remove it to analyze the remaining routes.' }
            }
        }
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
                        label: `${pickLabel(pick.seasonYear, pick.round)} · ${pick.originalTeamName}`,
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
        return { analysis: analyzeDynastyTrade(
            dynastyEngineContext(input.leagueId, seasonYear, input.scoringSettings),
            'overall',
            routes,
        ), error: null }
    }, [input.enabled, input.faabBudget, input.items, input.leagueId, input.participants,
        input.scoringSettings, input.teams, rows, seasonYear, resultScope, scopeKey, loading, error])

    return {
        analysis: result.analysis,
        seasonYear: resultScope === scopeKey ? seasonYear : null,
        loading: Boolean(input.enabled && input.leagueId && input.memberId && (loading || resultScope !== scopeKey)),
        error: resultScope === scopeKey ? error ?? result.error : null,
    }
}

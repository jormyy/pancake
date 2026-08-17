import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import {
    dynastyDecisionCacheKey,
    dynastyDecisionLatestCacheKey,
    dynastyEngineContext,
    dynastyScoringSignature,
    getDynastyDecisionInputs,
    getUnmatchedRookieRankings,
    playerAssetFromDecisionInput,
    type DynastyDecisionInput,
    type UnmatchedRookieRanking,
} from '@/lib/dynasty-decisions'
import { getCurrentSeason, currentSeasonYear } from '@/lib/shared/season'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import type { DynastyRankPlayer } from '@/lib/dynasty'
import type { Json } from '@/types/database'
import {
    valueDynastyAsset,
    type DynastyAssetResult,
    type DynastyStrategy,
} from '@pancake/core'

const STALE_MS = 5 * 60_000
const MAX_RANKINGS = 600
const FUTURE_PICK_YEARS = 3
const FUTURE_PICK_ROUNDS = 4

export type DynastyRankingView = DynastyStrategy | 'rookies-picks'

type DynastyRankingsCache = {
    players: DynastyRankPlayer[]
    savedAt: number
    seasonYear: number
}

type UseDynastyRankingsArgs = {
    userId: string
    memberId: string
    leagueId: string
    scoringSettings: Json | null | undefined
    teamCount: number
}

const viewStrategy = (view: DynastyRankingView): DynastyStrategy =>
    view === 'contend' || view === 'rebuild' ? view : 'overall'

function playerRow(row: DynastyDecisionInput, result: DynastyAssetResult): DynastyRankPlayer {
    return {
        rankingId: row.dynasty_ranking_id ?? `player:${row.player_id}`,
        playerId: row.player_id,
        displayName: row.display_name,
        sourceName: row.display_name,
        sourceTeam: row.nba_team,
        sourcePositions: row.position ? [row.position] : [],
        nbaTeam: row.nba_team,
        position: row.position,
        eligiblePositions: row.eligible_positions ?? [],
        injuryStatus: row.injury_status,
        yearsExp: row.years_exp,
        headshotUrl: row.headshot_url,
        nbaId: row.nba_id,
        dynastyRank: row.dynasty_rank ?? MAX_RANKINGS,
        rankChange: row.rank_change ?? 0,
        age: row.age,
        gamesPlayed: row.games_played,
        fieldGoalPct: null,
        freeThrowPct: null,
        threePointersMade: row.avg_three_pointers_made,
        points: row.avg_points,
        rebounds: row.avg_rebounds,
        assists: row.avg_assists,
        steals: row.avg_steals,
        blocks: row.avg_blocks,
        turnovers: row.avg_turnovers,
        comment: null,
        rankSource: row.ranking_source ?? 'Pancake dynasty-points engine',
        scoringFormat: 'custom',
        sourceUrl: null,
        sourceMetadata: null,
        rankFetchedAt: row.ranking_fetched_at ?? row.projection_fetched_at ?? new Date(0).toISOString(),
        isDraftPick: false,
        isRookie: row.years_exp === 0,
        sourceRanks: {
            overall: row.dynasty_rank,
            contend: row.contend_rank,
            rebuild: row.rebuild_rank,
            rookie: row.rookie_rank,
        },
        strategyValues: result.values,
        shortTermPoints: result.components.shortTermPoints,
        projectionPoints: row.projection_fantasy_points,
        longTermValue: result.components.longTermValue,
        confidence: result.confidence,
        decisionSources: result.sources,
        missingInputs: result.missingInputs,
        assumptions: result.assumptions,
    }
}

function futurePickRows(
    leagueId: string,
    seasonYear: number,
    scoringSettings: Json | null | undefined,
    teamCount: number,
): DynastyRankPlayer[] {
    const context = dynastyEngineContext(leagueId, seasonYear, scoringSettings)
    const rows: DynastyRankPlayer[] = []
    for (let distance = 1; distance <= FUTURE_PICK_YEARS; distance += 1) {
        for (let round = 1; round <= FUTURE_PICK_ROUNDS; round += 1) {
            const year = seasonYear + distance
            const result = valueDynastyAsset(context, {
                kind: 'pick',
                id: `pick-band:${year}:${round}`,
                label: `${year} Round ${round}`,
                seasonYear: year,
                round,
                slot: null,
                teams: Math.max(teamCount, 4),
                sources: [{ name: 'Pancake deterministic pick curve', fetchedAt: null }],
            })
            rows.push({
                rankingId: result.assetId,
                playerId: null,
                displayName: result.label,
                sourceName: result.label,
                sourceTeam: 'DRA',
                sourcePositions: [],
                nbaTeam: null,
                position: null,
                eligiblePositions: [],
                injuryStatus: null,
                yearsExp: null,
                headshotUrl: null,
                nbaId: null,
                dynastyRank: MAX_RANKINGS,
                rankChange: 0,
                age: null,
                gamesPlayed: null,
                fieldGoalPct: null,
                freeThrowPct: null,
                threePointersMade: null,
                points: null,
                rebounds: null,
                assists: null,
                steals: null,
                blocks: null,
                turnovers: null,
                comment: null,
                rankSource: 'Pancake deterministic pick curve',
                scoringFormat: 'custom',
                sourceUrl: null,
                sourceMetadata: null,
                rankFetchedAt: new Date(0).toISOString(),
                isDraftPick: true,
                strategyValues: result.values,
                valueRange: result.ranges.overall ?? null,
                shortTermPoints: 0,
                projectionPoints: 0,
                longTermValue: result.components.longTermValue,
                confidence: result.confidence,
                decisionSources: result.sources,
                missingInputs: result.missingInputs,
                assumptions: result.assumptions,
            })
        }
    }
    return rows
}

function unmatchedRookieRows(
    rankings: UnmatchedRookieRanking[],
    leagueId: string,
    seasonYear: number,
    scoringSettings: Json | null | undefined,
): DynastyRankPlayer[] {
    const context = dynastyEngineContext(leagueId, seasonYear, scoringSettings)
    return rankings.map((ranking) => {
        const result = valueDynastyAsset(context, {
            kind: 'player',
            id: ranking.id,
            label: ranking.source_player_name,
            age: ranking.age,
            dynastyRank: ranking.source_rank,
            rankMovement: null,
            healthStatus: null,
            isRookie: true,
            sources: [{ name: 'hashtagbasketball.com/rookie', fetchedAt: ranking.fetched_at }],
        })
        return {
            rankingId: ranking.id,
            playerId: null,
            displayName: ranking.source_player_name,
            sourceName: ranking.source_player_name,
            sourceTeam: ranking.source_team,
            sourcePositions: ranking.source_positions,
            nbaTeam: ranking.source_team,
            position: ranking.source_positions[0] ?? null,
            eligiblePositions: ranking.source_positions,
            injuryStatus: null,
            yearsExp: 0,
            headshotUrl: null,
            nbaId: null,
            dynastyRank: ranking.source_rank,
            rankChange: 0,
            age: ranking.age,
            gamesPlayed: null,
            fieldGoalPct: null,
            freeThrowPct: null,
            threePointersMade: null,
            points: null,
            rebounds: null,
            assists: null,
            steals: null,
            blocks: null,
            turnovers: null,
            comment: null,
            rankSource: 'hashtagbasketball.com/rookie',
            scoringFormat: 'custom',
            sourceUrl: null,
            sourceMetadata: null,
            rankFetchedAt: ranking.fetched_at,
            isDraftPick: false,
            isRookie: true,
            sourceRanks: { overall: null, contend: null, rebuild: null, rookie: ranking.source_rank },
            strategyValues: result.values,
            selectedValue: result.values.overall,
            shortTermPoints: result.components.shortTermPoints,
            longTermValue: result.components.longTermValue,
            confidence: result.confidence,
            decisionSources: result.sources,
            missingInputs: result.missingInputs,
            assumptions: result.assumptions,
        }
    })
}

function rankedRows(
    inputRows: DynastyDecisionInput[],
    unmatchedRookies: UnmatchedRookieRanking[],
    view: DynastyRankingView,
    leagueId: string,
    seasonYear: number,
    scoringSettings: Json | null | undefined,
    teamCount: number,
    query: string,
): DynastyRankPlayer[] {
    const context = dynastyEngineContext(leagueId, seasonYear, scoringSettings)
    const strategy = viewStrategy(view)
    const playerRows = inputRows.map((row) => {
        const result = valueDynastyAsset(context, playerAssetFromDecisionInput(row))
        return playerRow(row, result)
    })
    const candidates = view === 'rookies-picks'
        ? [
            ...playerRows.filter((row) => row.sourceRanks?.rookie != null || row.isRookie),
            ...unmatchedRookieRows(unmatchedRookies, leagueId, seasonYear, scoringSettings),
            ...futurePickRows(leagueId, seasonYear, scoringSettings, teamCount),
        ]
        : playerRows
    const normalized = query.trim().toLocaleLowerCase()
    return candidates
        .filter((row) => !normalized || row.displayName.toLocaleLowerCase().includes(normalized))
        .sort((left, right) => {
            if (view !== 'rookies-picks') {
                const valueDelta = (right.strategyValues?.[strategy] ?? 0) - (left.strategyValues?.[strategy] ?? 0)
                if (valueDelta !== 0) return valueDelta
            }
            const leftRank = view === 'rookies-picks'
                ? left.sourceRanks?.rookie
                : left.sourceRanks?.[strategy] ?? left.sourceRanks?.overall
            const rightRank = view === 'rookies-picks'
                ? right.sourceRanks?.rookie
                : right.sourceRanks?.[strategy] ?? right.sourceRanks?.overall
            if (leftRank != null && rightRank != null && leftRank !== rightRank) return leftRank - rightRank
            if (leftRank != null) return -1
            if (rightRank != null) return 1
            return (right.strategyValues?.[strategy] ?? 0) - (left.strategyValues?.[strategy] ?? 0) ||
                left.displayName.localeCompare(right.displayName) ||
                left.rankingId.localeCompare(right.rankingId)
        })
        .map((row, index) => ({
            ...row,
            dynastyRank: index + 1,
            selectedValue: row.strategyValues?.[strategy] ?? 0,
            valueRange: row.isDraftPick ? row.valueRange : null,
        }))
}

export function useDynastyRankings({
    userId,
    memberId,
    leagueId,
    scoringSettings,
    teamCount,
}: UseDynastyRankingsArgs) {
    const [query, setQuery] = useState('')
    const [view, setView] = useState<DynastyRankingView>('overall')
    const scopeIdentity = `${userId}:${memberId}:${leagueId}`
    const scoringSignature = dynastyScoringSignature(scoringSettings)
    const [initialCache] = useState(() => {
        if (!userId || !memberId || !leagueId) return null
        return readPersistentCache<DynastyRankingsCache>(dynastyDecisionLatestCacheKey({
            userId,
            memberId,
            leagueId,
            strategy: 'overall',
            query: '',
            scoringSignature,
        }))
    })
    const [players, setPlayers] = useState<DynastyRankPlayer[]>(initialCache?.players ?? [])
    const [loading, setLoading] = useState(!initialCache)
    const [refreshing, setRefreshing] = useState(false)
    const [error, setError] = useState<Error | null>(null)
    const [ownerScope, setOwnerScope] = useState(scopeIdentity)
    const debouncedQuery = useDebouncedValue(query, 250)
    const requestSeqRef = useRef(0)
    const lastLoadedAtRef = useRef(initialCache?.savedAt ?? 0)
    const activeKeyRef = useRef(initialCache && userId && memberId && leagueId
        ? dynastyDecisionCacheKey({
            userId,
            memberId,
            leagueId,
            seasonYear: initialCache.seasonYear,
            strategy: 'overall',
            query: '',
            scoringSignature,
        })
        : '')
    const playersRef = useRef<DynastyRankPlayer[]>(initialCache?.players ?? [])

    useEffect(() => {
        playersRef.current = players
    }, [players])

    const scopeReady = Boolean(userId && memberId && leagueId)
    const load = useCallback(async (force = false) => {
        if (!scopeReady) {
            setOwnerScope(scopeIdentity)
            playersRef.current = []
            setPlayers([])
            setLoading(false)
            return
        }
        const requestId = ++requestSeqRef.current
        if (ownerScope !== scopeIdentity) {
            setOwnerScope(scopeIdentity)
            activeKeyRef.current = ''
            playersRef.current = []
            setPlayers([])
            lastLoadedAtRef.current = 0
            setLoading(true)
            setRefreshing(false)
        }
        setError(null)
        try {
            const fallbackSeasonYear = currentSeasonYear()
            const season = await getCurrentSeason(leagueId)
            if (requestSeqRef.current !== requestId) return
            const seasonYear = season?.seasonYear ?? fallbackSeasonYear
            const cacheQuery = view === 'rookies-picks'
                ? `rookies-picks:${debouncedQuery}`
                : debouncedQuery
            const cacheScope = {
                userId, memberId, leagueId, seasonYear, strategy: viewStrategy(view), query: cacheQuery,
                scoringSignature,
            }
            const cacheKey = dynastyDecisionCacheKey(cacheScope)
            const previousKey = activeKeyRef.current
            activeKeyRef.current = cacheKey
            const cached = readPersistentCache<DynastyRankingsCache>(cacheKey)
            if (cached && (!force || playersRef.current.length === 0)) {
                playersRef.current = cached.players
                setPlayers(cached.players)
                lastLoadedAtRef.current = cached.savedAt
                setLoading(false)
            } else if (previousKey !== cacheKey) {
                playersRef.current = []
                setPlayers([])
                lastLoadedAtRef.current = 0
            }
            const hasRows = playersRef.current.length > 0
            if (!force && cached && Date.now() - cached.savedAt < STALE_MS) return
            setLoading(!hasRows)
            setRefreshing(hasRows)
            const [inputs, unmatchedRookies] = await Promise.all([
                getDynastyDecisionInputs({
                    leagueId,
                    memberId,
                    seasonYear,
                    query: view === 'rookies-picks' ? '' : debouncedQuery,
                    limit: MAX_RANKINGS,
                }),
                view === 'rookies-picks' ? getUnmatchedRookieRankings() : Promise.resolve([]),
            ])
            if (requestSeqRef.current !== requestId || activeKeyRef.current !== cacheKey) return
            const nextPlayers = rankedRows(
                inputs, unmatchedRookies, view, leagueId, seasonYear, scoringSettings, teamCount, debouncedQuery,
            )
            const savedAt = Date.now()
            playersRef.current = nextPlayers
            lastLoadedAtRef.current = savedAt
            setPlayers(nextPlayers)
            writePersistentCache<DynastyRankingsCache>(cacheKey, { players: nextPlayers, savedAt, seasonYear })
            writePersistentCache<DynastyRankingsCache>(dynastyDecisionLatestCacheKey({
                userId, memberId, leagueId, strategy: viewStrategy(view), query: cacheQuery,
                scoringSignature,
            }), { players: nextPlayers, savedAt, seasonYear })
        } catch (cause) {
            if (requestSeqRef.current !== requestId) return
            const nextError = cause instanceof Error ? cause : new Error(String(cause))
            setError(nextError)
            console.error(nextError)
        } finally {
            if (requestSeqRef.current === requestId) {
                setLoading(false)
                setRefreshing(false)
            }
        }
    }, [debouncedQuery, leagueId, memberId, ownerScope, scopeIdentity, scopeReady, scoringSettings, scoringSignature, teamCount, userId, view])

    useEffect(() => {
        void load()
        return () => {
            requestSeqRef.current += 1
        }
    }, [load])

    useFocusEffect(useCallback(() => {
        if (Date.now() - lastLoadedAtRef.current >= STALE_MS) void load()
    }, [load]))

    const ownsScope = ownerScope === scopeIdentity
    return useMemo(() => ({
        query,
        setQuery,
        view,
        setView,
        players: ownsScope ? players : [],
        loading: ownsScope ? loading : true,
        refreshing: ownsScope ? refreshing : false,
        loadingMore: false,
        hasMore: false,
        error,
        loadMoreError: null,
        loadMore: () => {},
        retryLoadMore: () => {},
        refresh: () => load(true),
    }), [error, load, loading, ownsScope, players, query, refreshing, view])
}

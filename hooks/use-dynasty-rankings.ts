import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { leagueResourceAffects, leagueSnapshotRevision, listenForLeagueChanges } from '@/lib/league-changes'
import { sessionGeneration } from '@/lib/session-cache-registry'
import { todayET } from '@/lib/shared/dates'
import { usePanelActivity } from '@/contexts/panel-activity'
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
import { getErrorMessage } from '@/lib/shared/errors'
import type { DynastyRankPlayer } from '@/lib/dynasty'
import type { Json } from '@/types/database'
import {
    valueDynastyAsset,
    type DynastyAssetResult,
} from '@pancake/core'

const STALE_MS = 5 * 60_000
const MAX_RANKINGS = 600
const FUTURE_PICK_YEARS = 3
const FUTURE_PICK_ROUNDS = 4

export type DynastyRankingView = 'five-year' | 'three-year' | 'rookies-picks'

type DynastyRankingsCache = {
    inputs: DynastyDecisionInput[]
    unmatchedRookies: UnmatchedRookieRanking[]
    savedAt: number
    seasonYear: number
    revision?: string | null
    day?: string
}

type UseDynastyRankingsArgs = {
    enabled?: boolean
    userId: string
    memberId: string
    leagueId: string
    scoringSettings: Json | null | undefined
    teamCount: number
}

function freshSource(cache: DynastyRankingsCache, leagueId: string) {
    const revision = leagueSnapshotRevision(leagueId, 'daily')
    return revision !== null && cache.revision === revision && cache.day === todayET()
}

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
        careerGames: row.career_regular_season_games,
        headshotUrl: row.headshot_url,
        nbaId: row.nba_id,
        dynastyRank: row.five_year_rank ?? MAX_RANKINGS,
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
            fiveYear: row.five_year_rank,
            threeYear: row.three_year_rank,
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
            sourceRanks: { fiveYear: null, threeYear: null, rookie: ranking.source_rank },
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

const sourceRankForView = (row: DynastyRankPlayer, view: DynastyRankingView): number | null | undefined => {
    if (view === 'five-year') return row.sourceRanks?.fiveYear
    if (view === 'three-year') return row.sourceRanks?.threeYear
    return row.sourceRanks?.rookie
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
        : playerRows.filter((row) => sourceRankForView(row, view) != null)
    const normalized = query.trim().toLocaleLowerCase()
    return candidates
        .filter((row) => !normalized || row.displayName.toLocaleLowerCase().includes(normalized))
        .sort((left, right) => {
            const leftRank = sourceRankForView(left, view)
            const rightRank = sourceRankForView(right, view)
            if (leftRank != null && rightRank != null && leftRank !== rightRank) return leftRank - rightRank
            if (leftRank != null) return -1
            if (rightRank != null) return 1
            return (right.strategyValues?.overall ?? 0) - (left.strategyValues?.overall ?? 0) ||
                left.displayName.localeCompare(right.displayName) ||
                left.rankingId.localeCompare(right.rankingId)
        })
        .map((row, index) => ({
            ...row,
            dynastyRank: sourceRankForView(row, view) ?? index + 1,
            selectedValue: row.strategyValues?.overall ?? 0,
            valueRange: row.isDraftPick ? row.valueRange : null,
        }))
}

export function useDynastyRankings({
    userId,
    memberId,
    leagueId,
    scoringSettings,
    teamCount,
    enabled = true,
}: UseDynastyRankingsArgs) {
    const panelActive = usePanelActivity()
    const active = enabled && panelActive
    const [query, setQuery] = useState('')
    const [view, setView] = useState<DynastyRankingView>('five-year')
    const generation = sessionGeneration()
    const scopeIdentity = `${userId}:${memberId}:${leagueId}:${generation}`
    const scoringSignature = dynastyScoringSignature(scoringSettings)
    const [initialCache] = useState(() => {
        if (!userId || !memberId || !leagueId) return null
        return readPersistentCache<DynastyRankingsCache>(dynastyDecisionLatestCacheKey({
            userId,
            memberId,
            leagueId,
            scoringSignature,
        }))
    })
    const [inputs, setInputs] = useState<DynastyDecisionInput[]>(initialCache?.inputs ?? [])
    const [unmatchedRookies, setUnmatchedRookies] = useState<UnmatchedRookieRanking[]>(initialCache?.unmatchedRookies ?? [])
    const [seasonYear, setSeasonYear] = useState(initialCache?.seasonYear ?? currentSeasonYear())
    const [loading, setLoading] = useState(!initialCache)
    const [refreshing, setRefreshing] = useState(false)
    const [error, setError] = useState<Error | null>(null)
    const [ownerScope, setOwnerScope] = useState(scopeIdentity)
    const requestSeqRef = useRef(0)
    const lastLoadedAtRef = useRef(initialCache && freshSource(initialCache, leagueId) ? initialCache.savedAt : 0)
    const lastDayRef = useRef(todayET())
    const currentSeasonRef = useRef<string | null>(null)
    const activeKeyRef = useRef(initialCache && userId && memberId && leagueId
        ? dynastyDecisionCacheKey({
            userId,
            memberId,
            leagueId,
            seasonYear: initialCache.seasonYear,
            scoringSignature,
        })
        : '')
    const hasDataRef = useRef(Boolean(initialCache))

    const focusedRef = useRef(false)
    const resumeNeededRef = useRef(false)
    const networkEpochRef = useRef(0)
    const lastOnlineRef = useRef<{ epoch: number; at: number } | null>(null)
    const failedRef = useRef(false)
    const inFlightRef = useRef<{
        identity: string; requestId: number; epoch: number; force: boolean; sourceRevision: string | null; promise: Promise<void>
    } | null>(null)
    const scopeReady = Boolean(userId && memberId && leagueId)
    const load = useCallback(async (force = false): Promise<void> => {
        if (!scopeReady) {
            setOwnerScope(scopeIdentity)
            setInputs([])
            setUnmatchedRookies([])
            hasDataRef.current = false
            setLoading(false)
            return
        }
        const identity = `${scopeIdentity}:${scoringSignature}`
        if (ownerScope !== scopeIdentity) {
            setOwnerScope(scopeIdentity)
            activeKeyRef.current = ''
            setInputs([])
            setUnmatchedRookies([])
            hasDataRef.current = false
            lastLoadedAtRef.current = 0
            setLoading(true)
            setRefreshing(false)
            setError(null)
        }
        if (!active || (typeof document !== 'undefined' && document.visibilityState === 'hidden') ||
            (typeof navigator !== 'undefined' && navigator.onLine === false)) {
            resumeNeededRef.current ||= force || Boolean(inFlightRef.current)
            setLoading(false)
            setRefreshing(false)
            if (!hasDataRef.current && typeof navigator !== 'undefined' && navigator.onLine === false) {
                setError(new Error('No saved rankings. Connect to load them.'))
            }
            return
        }
        force ||= resumeNeededRef.current
        resumeNeededRef.current = false
        const sourceRevision = leagueSnapshotRevision(leagueId, 'daily')
        const day = todayET()
        const pending = inFlightRef.current
        if (pending?.identity === identity && pending.requestId === requestSeqRef.current) {
            if (!force || (pending.force && pending.epoch === networkEpochRef.current && pending.sourceRevision === sourceRevision)) return pending.promise
            return pending.promise.then(() => {
                if (requestSeqRef.current !== pending.requestId || !focusedRef.current) return
                return load(true)
            })
        }
        const requestId = ++requestSeqRef.current
        const epoch = networkEpochRef.current
        const task = (async () => {
            setError(null)
            failedRef.current = false
            try {
                const fallbackSeasonYear = currentSeasonYear()
                const season = await getCurrentSeason(leagueId)
                if (requestSeqRef.current !== requestId || epoch !== networkEpochRef.current || sessionGeneration() !== generation) return
                currentSeasonRef.current = season?.id ?? null
                const seasonYear = season?.seasonYear ?? fallbackSeasonYear
                const cacheScope = {
                    userId, memberId, leagueId, seasonYear, scoringSignature,
                }
                const cacheKey = dynastyDecisionCacheKey(cacheScope)
                const previousKey = activeKeyRef.current
                activeKeyRef.current = cacheKey
                const cached = readPersistentCache<DynastyRankingsCache>(cacheKey)
                if (cached && (!force || !hasDataRef.current)) {
                    setInputs(cached.inputs)
                    setUnmatchedRookies(cached.unmatchedRookies)
                    setSeasonYear(cached.seasonYear)
                    hasDataRef.current = true
                    lastLoadedAtRef.current = freshSource(cached, leagueId) ? cached.savedAt : 0
                    setLoading(false)
                } else if (previousKey !== cacheKey) {
                    setInputs([])
                    setUnmatchedRookies([])
                    hasDataRef.current = false
                    lastLoadedAtRef.current = 0
                }
                const hasData = hasDataRef.current
                if (!force && cached && freshSource(cached, leagueId) && Date.now() - cached.savedAt < STALE_MS) return
                if ((typeof document !== 'undefined' && document.visibilityState === 'hidden') ||
                    (typeof navigator !== 'undefined' && navigator.onLine === false)) {
                    resumeNeededRef.current = true
                    return
                }
                setLoading(!hasData)
                setRefreshing(hasData)
                const [inputs, unmatchedRookies] = await Promise.all([
                    getDynastyDecisionInputs({
                        leagueId,
                        memberId,
                        seasonYear,
                        limit: MAX_RANKINGS,
                    }),
                    getUnmatchedRookieRankings(),
                ])
                if (requestSeqRef.current !== requestId || activeKeyRef.current !== cacheKey || epoch !== networkEpochRef.current || sessionGeneration() !== generation) return
                const savedAt = Date.now()
                setInputs(inputs)
                setUnmatchedRookies(unmatchedRookies)
                setSeasonYear(seasonYear)
                hasDataRef.current = true
                lastLoadedAtRef.current = day === todayET() && sourceRevision !== null && sourceRevision === leagueSnapshotRevision(leagueId, 'daily') ? savedAt : 0
                lastDayRef.current = day
                const cacheValue = { inputs, unmatchedRookies, savedAt, seasonYear, day, revision: sourceRevision }
                writePersistentCache<DynastyRankingsCache>(cacheKey, cacheValue)
                writePersistentCache<DynastyRankingsCache>(dynastyDecisionLatestCacheKey({
                    userId, memberId, leagueId, scoringSignature,
                }), cacheValue)
            } catch (cause) {
                if (requestSeqRef.current !== requestId || epoch !== networkEpochRef.current || sessionGeneration() !== generation) return
                failedRef.current = true
                const nextError = cause instanceof Error ? cause : new Error(getErrorMessage(cause))
                setError(nextError)
                console.error(nextError)
            } finally {
                if (requestSeqRef.current === requestId) {
                    setLoading(false)
                    setRefreshing(false)
                }
                if (inFlightRef.current?.requestId === requestId) inFlightRef.current = null
            }
        })()
        inFlightRef.current = { identity, requestId, epoch, force, sourceRevision, promise: task }
        return task
    }, [active, leagueId, memberId, ownerScope, scopeIdentity, scopeReady, scoringSignature, userId, generation])

    useEffect(() => {
        void load()
        return () => {
            requestSeqRef.current += 1
        }
    }, [load])

    useFocusEffect(useCallback(() => {
        focusedRef.current = true
        if (resumeNeededRef.current) {
            resumeNeededRef.current = false
            void load(true)
        } else if ((lastDayRef.current !== todayET() || Date.now() - lastLoadedAtRef.current >= STALE_MS)) void load()
        return () => {
            focusedRef.current = false
            if (inFlightRef.current) {
                resumeNeededRef.current = true
                requestSeqRef.current += 1
                inFlightRef.current = null
            }
        }
    }, [load]))

    useEffect(() => {
        if (typeof window === 'undefined' || typeof document === 'undefined') return
        const resume = () => {
            if (!focusedRef.current || document.visibilityState === 'hidden' || navigator.onLine === false) return
            const force = resumeNeededRef.current || failedRef.current
            resumeNeededRef.current = false
            if (force || (lastDayRef.current !== todayET() || Date.now() - lastLoadedAtRef.current >= STALE_MS)) void load(force)
        }
        const online = () => {
            const previous = lastOnlineRef.current
            const now = Date.now()
            if (previous?.epoch === networkEpochRef.current && now - previous.at < 1000 && !failedRef.current) return
            lastOnlineRef.current = { epoch: networkEpochRef.current, at: now }
            resumeNeededRef.current = true
            resume()
        }
        const offline = () => {
            networkEpochRef.current += 1
            requestSeqRef.current += 1
            inFlightRef.current = null
            resumeNeededRef.current = true
        }
        const visibility = () => {
            if (document.visibilityState === 'hidden' && inFlightRef.current) {
                resumeNeededRef.current = true
                requestSeqRef.current += 1
                inFlightRef.current = null
            } else resume()
        }
        window.addEventListener('online', online)
        window.addEventListener('offline', offline)
        window.addEventListener('focus', resume)
        document.addEventListener('visibilitychange', visibility)
        return () => {
            window.removeEventListener('online', online)
            window.removeEventListener('offline', offline)
            window.removeEventListener('focus', resume)
            document.removeEventListener('visibilitychange', visibility)
        }
    }, [load])

    useEffect(() => {
        if (!scopeReady) return
        let registering = true
        const stop = listenForLeagueChanges(leagueId, change => {
            if (registering && change.topic === 'catchup') return
            if (!leagueResourceAffects(change, ['averages', 'projections', 'scoring', 'season'], { seasonId: currentSeasonRef.current })) return
            lastLoadedAtRef.current = 0
            resumeNeededRef.current = true
            if (focusedRef.current && active) void load(true)
        })
        registering = false
        return stop
    }, [active, leagueId, load, scopeReady])

    const ownsScope = ownerScope === scopeIdentity
    const players = useMemo(() => rankedRows(
        inputs,
        unmatchedRookies,
        view,
        leagueId,
        seasonYear,
        scoringSettings,
        teamCount,
        query,
    ), [inputs, leagueId, query, scoringSettings, seasonYear, teamCount, unmatchedRookies, view])
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

import { useEffect, useState, useCallback, useRef } from 'react'
import {
    getPlayer,
    getAvailableSeasons,
    getPlayerSeasonAveragesFromView,
    getPlayerGameLog,
    getPlayerFantasyPoints,
    getPlayerTransactionHistory,
    type GameLogEntry,
    type PlayerDetailRow,
    type PlayerSeasonAverages,
    type TransactionHistoryEntry,
} from '@/lib/players'
import { currentSeasonYear } from '@/lib/shared/season'
import { todayET } from '@/lib/shared/dates'
import { supabase } from '@/lib/supabase'
import { getPlayerProjection, type LeagueProjectionRow } from '@/lib/projections'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'

const GAME_LOG_PAGE = 15
type SeasonCacheEntry = {
    seasonAverages: PlayerSeasonAverages | null
    gameLog: GameLogEntry[]
    gameLogOffset: number
    hasMoreGames: boolean
    fantasyPointsMap: Map<string, number> | null
    avgFantasyPoints: number
}
type PersistedSeasonCacheEntry = Omit<SeasonCacheEntry, 'fantasyPointsMap'> & {
    fantasyPointEntries: [string, number][] | null
}
type PlayerScreenCache = {
    today: string
    player: PlayerDetailRow | null
    playedToday: boolean
    availableSeasons: number[]
    selectedSeason: number
    seasons: [string, PersistedSeasonCacheEntry][]
    nextProjection: LeagueProjectionRow | null
    transactions: TransactionHistoryEntry[]
}
type PlayerScreenCacheState = Omit<PlayerScreenCache, 'today' | 'seasons'>

const PLAYER_SCREEN_CACHE_PREFIX = 'pancake:player-screen:v1:'

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === 'string') return error
    return 'Unknown error'
}

function seasonCacheKey(playerId: string, leagueId: string | null, season: number): string {
    return `${playerId}:${leagueId ?? 'no-league'}:${season}`
}

function playerScreenCacheKey(playerId: string, leagueId: string | null) {
    return `${PLAYER_SCREEN_CACHE_PREFIX}${leagueId ?? 'no-league'}:${playerId}`
}

function toPersistedSeasonEntry(entry: SeasonCacheEntry): PersistedSeasonCacheEntry {
    return {
        ...entry,
        fantasyPointEntries: entry.fantasyPointsMap ? Array.from(entry.fantasyPointsMap.entries()) : null,
    }
}

function fromPersistedSeasonEntry(entry: PersistedSeasonCacheEntry): SeasonCacheEntry {
    return {
        seasonAverages: entry.seasonAverages,
        gameLog: entry.gameLog,
        gameLogOffset: entry.gameLogOffset,
        hasMoreGames: entry.hasMoreGames,
        fantasyPointsMap: entry.fantasyPointEntries ? new Map(entry.fantasyPointEntries) : null,
        avgFantasyPoints: entry.avgFantasyPoints,
    }
}

function seasonCacheEntries(cache: PlayerScreenCache | undefined): [string, SeasonCacheEntry][] {
    return (cache?.seasons ?? []).map(([key, entry]) => [key, fromPersistedSeasonEntry(entry)])
}

function readPlayerScreenCache(playerId: string, leagueId: string | null): PlayerScreenCache | undefined {
    const cached = readPersistentCache<PlayerScreenCache>(playerScreenCacheKey(playerId, leagueId))
    if (!cached || cached.today !== todayET()) return undefined
    return cached
}

export function usePlayerScreenData(playerId: string, leagueId: string | null) {
    const initialCacheRef = useRef<{ loaded: boolean; value?: PlayerScreenCache }>({ loaded: false })
    if (!initialCacheRef.current.loaded) {
        initialCacheRef.current = { loaded: true, value: readPlayerScreenCache(playerId, leagueId) }
    }
    const initialCache = initialCacheRef.current.value
    const initialSelectedSeason = initialCache?.selectedSeason ?? currentSeasonYear()
    const initialSeason = initialCache
        ? new Map(seasonCacheEntries(initialCache)).get(seasonCacheKey(playerId, leagueId, initialSelectedSeason))
        : undefined

    const [player, setPlayer] = useState<PlayerDetailRow | null>(initialCache?.player ?? null)
    const [loading, setLoading] = useState(!initialCache?.player)
    const [playerError, setPlayerError] = useState<string | null>(null)
    const [playedToday, setPlayedToday] = useState(initialCache?.playedToday ?? false)

    const [availableSeasons, setAvailableSeasons] = useState<number[]>(initialCache?.availableSeasons ?? [])
    const [selectedSeason, setSelectedSeason] = useState<number>(initialSelectedSeason)

    const [seasonAverages, setSeasonAverages] = useState<PlayerSeasonAverages | null>(initialSeason?.seasonAverages ?? null)
    const [seasonLoading, setSeasonLoading] = useState(false)
    const [seasonError, setSeasonError] = useState<string | null>(null)

    const [gameLog, setGameLog] = useState<GameLogEntry[]>(initialSeason?.gameLog ?? [])
    const [gameLogOffset, setGameLogOffset] = useState(initialSeason?.gameLogOffset ?? 0)
    const [hasMoreGames, setHasMoreGames] = useState(initialSeason?.hasMoreGames ?? false)
    const [gameLogLoading, setGameLogLoading] = useState(false)
    const [gameLogError, setGameLogError] = useState<string | null>(null)

    const [fantasyPointsMap, setFantasyPointsMap] = useState<Map<string, number> | null>(initialSeason?.fantasyPointsMap ?? null)
    const [avgFantasyPoints, setAvgFantasyPoints] = useState(initialSeason?.avgFantasyPoints ?? 0)
    const [nextProjection, setNextProjection] = useState<LeagueProjectionRow | null>(initialCache?.nextProjection ?? null)
    const [projectionError, setProjectionError] = useState<string | null>(null)

    const [transactions, setTransactions] = useState<TransactionHistoryEntry[]>(initialCache?.transactions ?? [])
    const [transactionsError, setTransactionsError] = useState<string | null>(null)
    const cacheStateRef = useRef<PlayerScreenCacheState>({
        player: initialCache?.player ?? null,
        playedToday: initialCache?.playedToday ?? false,
        availableSeasons: initialCache?.availableSeasons ?? [],
        selectedSeason: initialSelectedSeason,
        nextProjection: initialCache?.nextProjection ?? null,
        transactions: initialCache?.transactions ?? [],
    })
    const seasonCacheRef = useRef(new Map<string, SeasonCacheEntry>(seasonCacheEntries(initialCache)))
    const seasonRequestRef = useRef(0)

    const persistScreenCache = useCallback(() => {
        writePersistentCache<PlayerScreenCache>(playerScreenCacheKey(playerId, leagueId), {
            today: todayET(),
            ...cacheStateRef.current,
            seasons: Array.from(seasonCacheRef.current.entries()).map(([key, entry]) => [
                key,
                toPersistedSeasonEntry(entry),
            ]),
        })
    }, [playerId, leagueId])

    const applyScreenCache = useCallback((cache: PlayerScreenCache | undefined) => {
        seasonCacheRef.current = new Map(seasonCacheEntries(cache))
        const nextSelectedSeason = cache?.selectedSeason ?? currentSeasonYear()
        const nextSeason = seasonCacheRef.current.get(seasonCacheKey(playerId, leagueId, nextSelectedSeason))
        cacheStateRef.current = {
            player: cache?.player ?? null,
            playedToday: cache?.playedToday ?? false,
            availableSeasons: cache?.availableSeasons ?? [],
            selectedSeason: nextSelectedSeason,
            nextProjection: cache?.nextProjection ?? null,
            transactions: cache?.transactions ?? [],
        }
        setPlayer(cache?.player ?? null)
        setLoading(!cache?.player)
        setPlayerError(null)
        setPlayedToday(cache?.playedToday ?? false)
        setAvailableSeasons(cache?.availableSeasons ?? [])
        setSelectedSeason(nextSelectedSeason)
        setSeasonAverages(nextSeason?.seasonAverages ?? null)
        setSeasonLoading(false)
        setSeasonError(null)
        setGameLog(nextSeason?.gameLog ?? [])
        setGameLogOffset(nextSeason?.gameLogOffset ?? 0)
        setHasMoreGames(nextSeason?.hasMoreGames ?? false)
        setGameLogLoading(false)
        setGameLogError(null)
        setFantasyPointsMap(nextSeason?.fantasyPointsMap ?? null)
        setAvgFantasyPoints(nextSeason?.avgFantasyPoints ?? 0)
        setNextProjection(cache?.nextProjection ?? null)
        setProjectionError(null)
        setTransactions(cache?.transactions ?? [])
        setTransactionsError(null)
    }, [playerId, leagueId])

    useEffect(() => {
        seasonRequestRef.current += 1
        const cached = readPlayerScreenCache(playerId, leagueId)
        applyScreenCache(cached)
        const hasVisiblePlayer = cached?.player != null
        setLoading(!hasVisiblePlayer)
        async function load() {
            try {
                const [p, seasons, todayStats] = await Promise.all([
                    getPlayer(playerId),
                    getAvailableSeasons(playerId),
                    supabase
                        .from('player_game_stats')
                        .select('did_not_play')
                        .eq('player_id', playerId)
                        // player_game_stats.game_date is ET-keyed (backend writes via todayET());
                        // use todayET so non-ET clients don't query against the wrong date.
                        .eq('game_date', todayET())
                        .maybeSingle(),
                ])
                const didPlayToday = todayStats.data != null && todayStats.data.did_not_play === false
                setPlayedToday(didPlayToday)
                setPlayer(p)
                setAvailableSeasons(seasons)
                const currentYear = currentSeasonYear()
                const currentSelectedSeason = cacheStateRef.current.selectedSeason
                const nextSelectedSeason = seasons.includes(currentSelectedSeason)
                    ? currentSelectedSeason
                    : seasons.length > 0 && !seasons.includes(currentYear)
                    ? seasons[0]
                    : currentYear
                setSelectedSeason(nextSelectedSeason)
                cacheStateRef.current = {
                    ...cacheStateRef.current,
                    player: p,
                    playedToday: didPlayToday,
                    availableSeasons: seasons,
                    selectedSeason: nextSelectedSeason,
                }
                persistScreenCache()
                setPlayerError(null)
            } catch (e) {
                setPlayerError(errorMessage(e))
            } finally {
                setLoading(false)
            }
        }
        load()
    }, [playerId, leagueId, applyScreenCache, persistScreenCache])

    useEffect(() => {
        if (!player || player.id !== playerId) return
        const playerTeam = player.nba_team
        const key = seasonCacheKey(playerId, leagueId, selectedSeason)
        const requestId = ++seasonRequestRef.current
        const cached = seasonCacheRef.current.get(key)
        if (cached) {
            setSeasonAverages(cached.seasonAverages)
            setGameLog(cached.gameLog)
            setGameLogOffset(cached.gameLogOffset)
            setHasMoreGames(cached.hasMoreGames)
            setFantasyPointsMap(cached.fantasyPointsMap)
            setAvgFantasyPoints(cached.avgFantasyPoints)
            setSeasonLoading(false)
        } else {
            setSeasonAverages(null)
            setGameLog([])
            setGameLogOffset(0)
            setHasMoreGames(false)
            setFantasyPointsMap(null)
            setAvgFantasyPoints(0)
            setSeasonLoading(true)
        }
        async function loadSeasonData() {
            try {
                const [avgs, gameLogResult, fantasyPoints] = await Promise.all([
                    getPlayerSeasonAveragesFromView(playerId, selectedSeason),
                    getPlayerGameLog(playerId, playerTeam, selectedSeason, GAME_LOG_PAGE, 0),
                    leagueId ? getPlayerFantasyPoints(playerId, leagueId, selectedSeason) : Promise.resolve(null),
                ])
                if (seasonRequestRef.current !== requestId) return
                const fpMap = fantasyPoints ? new Map(fantasyPoints.map((p) => [p.gameId, p.fantasyPoints])) : null
                const avgFantasy = fantasyPoints && fantasyPoints.length > 0
                    ? fantasyPoints.reduce((sum, p) => sum + p.fantasyPoints, 0) / fantasyPoints.length
                    : 0
                const entry = {
                    seasonAverages: avgs,
                    gameLog: gameLogResult.games,
                    gameLogOffset: gameLogResult.games.length,
                    hasMoreGames: gameLogResult.hasMore,
                    fantasyPointsMap: fpMap,
                    avgFantasyPoints: avgFantasy,
                }
                seasonCacheRef.current.set(key, entry)
                persistScreenCache()
                setSeasonAverages(avgs)
                setGameLog(gameLogResult.games)
                setGameLogOffset(gameLogResult.games.length)
                setHasMoreGames(gameLogResult.hasMore)
                setFantasyPointsMap(fpMap)
                setAvgFantasyPoints(avgFantasy)
                setSeasonError(null)
            } catch (e) {
                setSeasonError(errorMessage(e))
            } finally {
                if (seasonRequestRef.current === requestId) setSeasonLoading(false)
            }
        }
        loadSeasonData()
    }, [playerId, leagueId, selectedSeason, player?.nba_team, persistScreenCache])

    // Load transaction history
    useEffect(() => {
        if (!leagueId) return
        async function loadTransactions() {
            try {
                const tx = await getPlayerTransactionHistory(playerId, leagueId!)
                setTransactions(tx)
                cacheStateRef.current = { ...cacheStateRef.current, transactions: tx }
                persistScreenCache()
                setTransactionsError(null)
            } catch (e) {
                setTransactionsError(errorMessage(e))
            }
        }
        loadTransactions()
    }, [playerId, leagueId])

    useEffect(() => {
        let cancelled = false
        if (!cacheStateRef.current.nextProjection || cacheStateRef.current.nextProjection.player_id !== playerId) {
            setNextProjection(null)
        }
        if (!leagueId) {
            cacheStateRef.current = { ...cacheStateRef.current, nextProjection: null }
            return
        }

        getPlayerProjection(playerId, leagueId)
            .then((projection) => {
                if (!cancelled) {
                    setNextProjection(projection)
                    cacheStateRef.current = { ...cacheStateRef.current, nextProjection: projection }
                    persistScreenCache()
                    setProjectionError(null)
                }
            })
            .catch((error) => {
                if (!cancelled) setProjectionError(errorMessage(error))
            })

        return () => { cancelled = true }
    }, [playerId, leagueId, persistScreenCache])

    const loadMoreGames = useCallback(async () => {
        if (gameLogLoading || !hasMoreGames || !player) return
        setGameLogLoading(true)
        try {
            const result = await getPlayerGameLog(
                playerId,
                player.nba_team,
                selectedSeason,
                GAME_LOG_PAGE,
                gameLogOffset,
            )
            setGameLog((prev) => {
                const merged = [...prev, ...result.games]
                const key = seasonCacheKey(playerId, leagueId, selectedSeason)
                const cached = seasonCacheRef.current.get(key)
                if (cached) {
                    seasonCacheRef.current.set(key, {
                        ...cached,
                        gameLog: merged,
                        gameLogOffset: gameLogOffset + result.games.length,
                        hasMoreGames: result.hasMore,
                    })
                    persistScreenCache()
                }
                return merged
            })
            setGameLogOffset(gameLogOffset + result.games.length)
            setHasMoreGames(result.hasMore)
            setGameLogError(null)
        } catch (e) {
            setGameLogError(errorMessage(e))
        } finally {
            setGameLogLoading(false)
        }
    }, [playerId, leagueId, player, selectedSeason, gameLogOffset, gameLogLoading, hasMoreGames, persistScreenCache])

    function handleSeasonSelect(year: number) {
        if (year !== selectedSeason) {
            setSelectedSeason(year)
            cacheStateRef.current = { ...cacheStateRef.current, selectedSeason: year }
            persistScreenCache()
        }
    }

    return {
        player, loading, playedToday,
        playerError,
        availableSeasons, selectedSeason, handleSeasonSelect,
        seasonAverages, seasonLoading,
        seasonError,
        gameLog, hasMoreGames, gameLogLoading, loadMoreGames,
        gameLogError,
        fantasyPointsMap, avgFantasyPoints,
        nextProjection, projectionError,
        transactions, transactionsError,
    }
}

import { useEffect, useState, useCallback, useRef } from 'react'
import {
    getPlayer,
    getAvailableSeasons,
    getPlayerSeasonAveragesFromView,
    getPlayerGameLog,
    getPlayerFantasyPoints,
    getPlayerTransactionHistory,
    type GameLogEntry,
    type PlayerSeasonAverages,
    type TransactionHistoryEntry,
} from '@/lib/players'
import { currentSeasonYear } from '@/lib/shared/season'
import { todayET } from '@/lib/shared/dates'
import { supabase } from '@/lib/supabase'

const GAME_LOG_PAGE = 15
type SeasonCacheEntry = {
    seasonAverages: PlayerSeasonAverages | null
    gameLog: GameLogEntry[]
    gameLogOffset: number
    hasMoreGames: boolean
    fantasyPointsMap: Map<string, number> | null
    avgFantasyPoints: number
}

function seasonCacheKey(playerId: string, leagueId: string | null, season: number): string {
    return `${playerId}:${leagueId ?? 'no-league'}:${season}`
}

export function usePlayerScreenData(playerId: string, leagueId: string | null) {
    const [player, setPlayer] = useState<any>(null)
    const [loading, setLoading] = useState(true)
    const [playedToday, setPlayedToday] = useState(false)

    const [availableSeasons, setAvailableSeasons] = useState<number[]>([])
    const [selectedSeason, setSelectedSeason] = useState<number>(currentSeasonYear())

    const [seasonAverages, setSeasonAverages] = useState<PlayerSeasonAverages | null>(null)
    const [seasonLoading, setSeasonLoading] = useState(false)

    const [gameLog, setGameLog] = useState<GameLogEntry[]>([])
    const [gameLogOffset, setGameLogOffset] = useState(0)
    const [hasMoreGames, setHasMoreGames] = useState(false)
    const [gameLogLoading, setGameLogLoading] = useState(false)

    const [fantasyPointsMap, setFantasyPointsMap] = useState<Map<string, number> | null>(null)
    const [avgFantasyPoints, setAvgFantasyPoints] = useState(0)

    const [transactions, setTransactions] = useState<TransactionHistoryEntry[]>([])
    const seasonCacheRef = useRef(new Map<string, SeasonCacheEntry>())
    const seasonRequestRef = useRef(0)

    useEffect(() => {
        seasonRequestRef.current += 1
        setLoading(true)
        setPlayer(null)
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
                setPlayedToday(todayStats.data != null && todayStats.data.did_not_play === false)
                setPlayer(p)
                setAvailableSeasons(seasons)
                if (seasons.length > 0 && !seasons.includes(currentSeasonYear())) {
                    setSelectedSeason(seasons[0])
                }
            } catch (e) {
                console.error(e)
            } finally {
                setLoading(false)
            }
        }
        load()
    }, [playerId])

    useEffect(() => {
        if (!player || player.id !== playerId) return
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
            return
        }

        setSeasonAverages(null)
        setGameLog([])
        setGameLogOffset(0)
        setHasMoreGames(false)
        setFantasyPointsMap(null)
        setAvgFantasyPoints(0)
        setSeasonLoading(true)
        async function loadSeasonData() {
            try {
                const [avgs, gameLogResult, fantasyPoints] = await Promise.all([
                    getPlayerSeasonAveragesFromView(playerId, selectedSeason),
                    getPlayerGameLog(playerId, player.nba_team, selectedSeason, GAME_LOG_PAGE, 0),
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
                setSeasonAverages(avgs)
                setGameLog(gameLogResult.games)
                setGameLogOffset(gameLogResult.games.length)
                setHasMoreGames(gameLogResult.hasMore)
                setFantasyPointsMap(fpMap)
                setAvgFantasyPoints(avgFantasy)
            } catch (e) {
                console.error(e)
            } finally {
                if (seasonRequestRef.current === requestId) setSeasonLoading(false)
            }
        }
        loadSeasonData()
    }, [playerId, leagueId, selectedSeason, player?.nba_team])

    // Load transaction history
    useEffect(() => {
        if (!leagueId) return
        async function loadTransactions() {
            try {
                const tx = await getPlayerTransactionHistory(playerId, leagueId!)
                setTransactions(tx)
            } catch (e) {
                console.error(e)
            }
        }
        loadTransactions()
    }, [playerId, leagueId])

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
                }
                return merged
            })
            setGameLogOffset(gameLogOffset + result.games.length)
            setHasMoreGames(result.hasMore)
        } catch (e) {
            console.error(e)
        } finally {
            setGameLogLoading(false)
        }
    }, [playerId, leagueId, player, selectedSeason, gameLogOffset, gameLogLoading, hasMoreGames])

    function handleSeasonSelect(year: number) {
        if (year !== selectedSeason) setSelectedSeason(year)
    }

    return {
        player, loading, playedToday,
        availableSeasons, selectedSeason, handleSeasonSelect,
        seasonAverages, seasonLoading,
        gameLog, hasMoreGames, gameLogLoading, loadMoreGames,
        fantasyPointsMap, avgFantasyPoints,
        transactions,
    }
}

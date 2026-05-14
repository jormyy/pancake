import { useEffect, useState, useCallback } from 'react'
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
import { todayDateString } from '@/lib/shared/dates'
import { supabase } from '@/lib/supabase'

const GAME_LOG_PAGE = 15

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

    // Load player core + available seasons
    useEffect(() => {
        setLoading(true)
        async function load() {
            try {
                const [p, seasons, todayStats] = await Promise.all([
                    getPlayer(playerId),
                    getAvailableSeasons(playerId),
                    supabase
                        .from('player_game_stats')
                        .select('did_not_play')
                        .eq('player_id', playerId)
                        .eq('game_date', todayDateString())
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

    // Load season-dependent data (averages + game log)
    useEffect(() => {
        if (!player) return
        setSeasonLoading(true)
        setGameLog([])
        setGameLogOffset(0)
        setHasMoreGames(false)
        setFantasyPointsMap(null)
        setAvgFantasyPoints(0)
        async function loadSeasonData() {
            try {
                const [avgs, gameLogResult] = await Promise.all([
                    getPlayerSeasonAveragesFromView(playerId, selectedSeason),
                    getPlayerGameLog(playerId, player.nba_team, selectedSeason, GAME_LOG_PAGE, 0),
                ])
                setSeasonAverages(avgs)
                setGameLog(gameLogResult.games)
                setGameLogOffset(gameLogResult.games.length)
                setHasMoreGames(gameLogResult.hasMore)
            } catch (e) {
                console.error(e)
            } finally {
                setSeasonLoading(false)
            }
        }
        loadSeasonData()
    }, [playerId, selectedSeason, player])

    // Load fantasy points (league-aware)
    useEffect(() => {
        if (!leagueId || !player) return
        async function loadFantasy() {
            try {
                const pts = await getPlayerFantasyPoints(playerId, leagueId!, selectedSeason)
                const map = new Map(pts.map((p) => [p.gameId, p.fantasyPoints]))
                setFantasyPointsMap(map)
                if (pts.length > 0) {
                    const avg = pts.reduce((sum, p) => sum + p.fantasyPoints, 0) / pts.length
                    setAvgFantasyPoints(avg)
                }
            } catch (e) {
                console.error(e)
            }
        }
        loadFantasy()
    }, [playerId, leagueId, selectedSeason, player])

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
            setGameLog((prev) => [...prev, ...result.games])
            setGameLogOffset((prev) => prev + result.games.length)
            setHasMoreGames(result.hasMore)
        } catch (e) {
            console.error(e)
        } finally {
            setGameLogLoading(false)
        }
    }, [playerId, player, selectedSeason, gameLogOffset, gameLogLoading, hasMoreGames])

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

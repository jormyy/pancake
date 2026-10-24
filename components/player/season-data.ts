import { calculateFantasyPoints, snakeToStatLine, type ScoringSettings } from '@pancake/core'
import type { GameLogEntry, PlayerSeasonAverages } from '@/lib/players'
import { readLeagueDaily } from '@/lib/league-daily-cache'
import { supabase } from '@/lib/supabase'

export async function getPlayerSeasonLines(playerId: string, seasonYear: number) {
    const { data, error } = await supabase.from('player_game_stats')
        .select(`id, game_date, did_not_play, minutes_played,
            points, rebounds, assists, steals, blocks, turnovers, personal_fouls,
            field_goals_made, field_goals_attempted, three_pointers_made, three_pointers_attempted,
            free_throws_made, free_throws_attempted, plus_minus, double_double, triple_double,
            nba_games!inner(id, nba_game_id, game_date, home_team, away_team, status, game_time, started_at)`)
        .eq('player_id', playerId)
        .eq('season_year', seasonYear)
        .like('nba_games.nba_game_id', '002%')
        .order('game_date', { ascending: false })
        .limit(100)
    if (error) throw error
    return data ?? []
}

export async function getPlayerScoringSettings(leagueId: string) {
    return readLeagueDaily(leagueId, 'player-scoring-settings', async () => {
        const { data, error } = await supabase.from('leagues').select('scoring_settings').eq('id', leagueId).single()
        if (error) throw error
        return data.scoring_settings
    })
}

export type PlayerSeasonLine = Awaited<ReturnType<typeof getPlayerSeasonLines>>[number]
export type PlayerGame = GameLogEntry & { live: boolean; nbaGameId: string }

export function summarizePlayerSeason(lines: PlayerSeasonLine[], team: string | null, scoring: ScoringSettings | null) {
    const games: PlayerGame[] = lines.map(row => {
        const game = row.nba_games
        const isHome = game.home_team === team
        return {
            gameId: row.id, nbaGameId: game.id, gameDate: game.game_date,
            opponent: isHome ? `vs ${game.away_team}` : `@ ${game.home_team}`, isHome,
            live: game.status === 'in_progress', didNotPlay: row.did_not_play,
            minutes: Number(row.minutes_played) || 0, points: row.points ?? 0,
            rebounds: row.rebounds ?? 0, assists: row.assists ?? 0, steals: row.steals ?? 0,
            blocks: row.blocks ?? 0, turnovers: row.turnovers ?? 0, personalFouls: row.personal_fouls ?? 0,
            fgMade: row.field_goals_made ?? 0, fgAttempted: row.field_goals_attempted ?? 0,
            threeMade: row.three_pointers_made ?? 0, threeAttempted: row.three_pointers_attempted ?? 0,
            ftMade: row.free_throws_made ?? 0, ftAttempted: row.free_throws_attempted ?? 0,
            plusMinus: row.plus_minus ?? 0, doubleDouble: row.double_double ?? false,
            tripleDouble: row.triple_double ?? false,
        }
    }).sort((a, b) => b.gameDate.localeCompare(a.gameDate) || b.gameId.localeCompare(a.gameId))
    const played = lines.filter(row => !row.did_not_play)
    const average = (key: keyof PlayerSeasonLine) => played.reduce((sum, row) => sum + (Number(row[key]) || 0), 0) / (played.length || 1)
    const averages: PlayerSeasonAverages | null = played.length ? {
        gamesPlayed: played.length, avgPoints: average('points'), avgRebounds: average('rebounds'),
        avgAssists: average('assists'), avgSteals: average('steals'), avgBlocks: average('blocks'),
        avgTurnovers: average('turnovers'), avgThreePointersMade: average('three_pointers_made'),
        avgFieldGoalsMade: average('field_goals_made'), avgFieldGoalsAttempted: average('field_goals_attempted'),
        avgFreeThrowsMade: average('free_throws_made'), avgFreeThrowsAttempted: average('free_throws_attempted'),
        avgMinutesPlayed: average('minutes_played'),
        doubleDoubles: played.filter(row => row.double_double).length,
        tripleDoubles: played.filter(row => row.triple_double).length,
    } : null
    const fantasyPointsMap = scoring ? new Map(lines.map(row => [row.id, calculateFantasyPoints(snakeToStatLine(row), scoring)])) : null
    const avgFantasyPoints = fantasyPointsMap && played.length
        ? played.reduce((sum, row) => sum + fantasyPointsMap.get(row.id)!, 0) / played.length : 0
    return { games, averages, fantasyPointsMap, avgFantasyPoints, includesLive: games.some(game => game.live && !game.didNotPlay) }
}

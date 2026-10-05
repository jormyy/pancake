import { supabase } from '@/lib/supabase'
import { isRegularSeasonGameId } from '@pancake/core'
import { gameHasStarted } from '@/lib/lineup/read'

export type NBAGameRow = {
    id: string
    nba_game_id: string | null
    home_team: string
    away_team: string
    home_score: number
    away_score: number
    status: string        // 'Scheduled' | 'InProgress' | 'Final'
    game_status_text: string | null  // 'Q3 5:23' | 'Halftime' | 'Final' | '7:30 pm ET'
    game_date: string
}

export type LiveStatLine = {
    points: number
    rebounds: number
    assists: number
    steals: number
    blocks: number
    turnovers: number | null
    threeMade: number
    fgMade: number
    fgAttempted: number
    ftMade: number
    ftAttempted: number
    fouls: number
    doubleDouble: boolean
    tripleDouble: boolean
    minutesPlayed: number | null
    didNotPlay: boolean
}

// Returns a map of playerId → live stats for all players with a game on the given date.
// Covers both InProgress and Final games so stats persist after a game ends.
export async function getLivePlayerStats(date: string): Promise<Map<string, LiveStatLine>> {
    const { data, error } = await supabase
        .from('player_game_stats')
        .select('player_id, points, rebounds, assists, steals, blocks, turnovers, three_pointers_made, field_goals_made, field_goals_attempted, free_throws_made, free_throws_attempted, personal_fouls, double_double, triple_double, minutes_played, did_not_play, nba_games!inner(nba_game_id)')
        .eq('game_date', date)
        .like('nba_games.nba_game_id', '002%')

    if (error) throw error
    const map = new Map<string, LiveStatLine>()
    for (const row of data ?? []) {
        const r = row as Record<string, unknown>
        map.set(row.player_id, {
            points: row.points ?? 0,
            rebounds: row.rebounds ?? 0,
            assists: row.assists ?? 0,
            steals: row.steals ?? 0,
            blocks: row.blocks ?? 0,
            turnovers: row.turnovers ?? null,
            threeMade: (r.three_pointers_made as number | null) ?? 0,
            fgMade: (r.field_goals_made as number | null) ?? 0,
            fgAttempted: (r.field_goals_attempted as number | null) ?? 0,
            ftMade: (r.free_throws_made as number | null) ?? 0,
            ftAttempted: (r.free_throws_attempted as number | null) ?? 0,
            fouls: (r.personal_fouls as number | null) ?? 0,
            doubleDouble: (r.double_double as boolean | null) ?? false,
            tripleDouble: (r.triple_double as boolean | null) ?? false,
            minutesPlayed: row.minutes_played != null ? Number(row.minutes_played) : null,
            didNotPlay: row.did_not_play ?? false,
        })
    }
    return map
}

export type GameDay = {
    startedTeams: Set<string>
    teamMatchups: Map<string, { opponent: string; isHome: boolean }>
    games: NBAGameRow[]
}

// One read of a date's slate: the teams whose game has started, each team's
// opponent, and the regular-season games ordered Final, InProgress, Scheduled.
// nba_games.game_date is stored in ET, so callers pass an ET date.
export async function getGameDay(date: string): Promise<GameDay> {
    const { data, error } = await supabase
        .from('nba_games')
        .select('id, nba_game_id, home_team, away_team, home_score, away_score, status, game_status_text, game_date, game_time, started_at')
        .eq('game_date', date)
        .returns<(NBAGameRow & { game_time: string | null; started_at: string | null })[]>()
    if (error) throw error

    const now = new Date().toISOString()
    const startedTeams = new Set<string>()
    const teamMatchups = new Map<string, { opponent: string; isHome: boolean }>()
    for (const game of data ?? []) {
        if (gameHasStarted(game, now)) {
            if (game.home_team) startedTeams.add(game.home_team)
            if (game.away_team) startedTeams.add(game.away_team)
        }
        if (game.home_team && game.away_team) {
            teamMatchups.set(game.home_team, { opponent: game.away_team, isHome: true })
            teamMatchups.set(game.away_team, { opponent: game.home_team, isHome: false })
        }
    }
    const games = (data ?? [])
        .filter((game) => isRegularSeasonGameId(game.nba_game_id))
        .sort((a, b) => (a.status < b.status ? -1 : a.status > b.status ? 1 : 0))
        .map(({ game_time: _gameTime, started_at: _startedAt, ...game }) => game)
    return { startedTeams, teamMatchups, games }
}

import { supabase } from '@/lib/supabase'

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
        .select('player_id, points, rebounds, assists, steals, blocks, turnovers, three_pointers_made, field_goals_made, field_goals_attempted, free_throws_made, free_throws_attempted, personal_fouls, double_double, triple_double, minutes_played, did_not_play')
        .eq('game_date', date)

    if (error) throw error
    const map = new Map<string, LiveStatLine>()
    for (const row of data ?? []) {
        map.set(row.player_id, {
            points: row.points ?? 0,
            rebounds: row.rebounds ?? 0,
            assists: row.assists ?? 0,
            steals: row.steals ?? 0,
            blocks: row.blocks ?? 0,
            turnovers: row.turnovers ?? null,
            threeMade: (row as any).three_pointers_made ?? 0,
            fgMade: (row as any).field_goals_made ?? 0,
            fgAttempted: (row as any).field_goals_attempted ?? 0,
            ftMade: (row as any).free_throws_made ?? 0,
            ftAttempted: (row as any).free_throws_attempted ?? 0,
            fouls: (row as any).personal_fouls ?? 0,
            doubleDouble: (row as any).double_double ?? false,
            tripleDouble: (row as any).triple_double ?? false,
            minutesPlayed: row.minutes_played != null ? Number(row.minutes_played) : null,
            didNotPlay: row.did_not_play ?? false,
        })
    }
    return map
}

export async function getTodaysGames(): Promise<NBAGameRow[]> {
    const today = new Date().toISOString().split('T')[0]
    const { data, error } = await supabase
        .from('nba_games')
        .select('id, nba_game_id, home_team, away_team, home_score, away_score, status, game_status_text, game_date')
        .eq('game_date', today)
        .order('status', { ascending: true }) // Final → InProgress → Scheduled

    if (error) throw error
    return (data ?? []) as unknown as NBAGameRow[]
}

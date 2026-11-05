export type LeagueProjectionRow = {
    player_id: string
    display_name: string
    nba_team: string | null
    position: string | null
    eligible_positions: string[]
    injury_status: string | null
    headshot_url: string | null
    nba_id: string | null
    next_game_date: string | null
    next_game_opponent: string | null
    next_game_time: string | null
    projection_source: string
    projection_source_label: string
    projection_view: string
    projection_fantasy_points: number | null
    projection_minutes: number | null
    projection_points: number | null
    projection_rebounds: number | null
    projection_assists: number | null
    projection_steals: number | null
    projection_blocks: number | null
    projection_three_pointers_made: number | null
    projection_turnovers: number | null
    projection_games_played: number | null
    projection_field_goal_pct: number | null
    projection_free_throw_pct: number | null
    projection_status: string | null
    projection_fetched_at: string | null
    projection_date: string | null
    projection_week_number: number | null
    projection_is_fresh: boolean | null
}

export function formatProjectionGame(row: Pick<LeagueProjectionRow, 'projection_date' | 'next_game_date' | 'next_game_opponent'>): string {
    const opponent = row.next_game_opponent
    const date = row.projection_date ?? row.next_game_date
    if (opponent && date) return `${opponent} ${shortDate(date)}`
    if (opponent) return opponent
    if (date) return shortDate(date)
    return ''
}

function shortDate(date: string): string {
    const parsed = new Date(`${date}T12:00:00Z`)
    if (!Number.isFinite(parsed.getTime())) return date
    return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

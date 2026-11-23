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

export type SleeperProjectionRow = {
    player_id: string
    team: string
    game_date: string
    last_modified: number
    points: number
    rebounds: number
    assists: number
    steals: number
    blocks: number
    three_pointers_made: number
    turnovers: number
    field_goals_made: number
    field_goals_attempted: number
    free_throws_made: number
    free_throws_attempted: number
    double_doubles: number | null
    triple_doubles: number | null
}

const SLEEPER_COLUMNS = 'player_id,team,game_date,last_modified,points,rebounds,assists,steals,blocks,three_pointers_made,turnovers,'
    + 'field_goals_made,field_goals_attempted,free_throws_made,free_throws_attempted,double_doubles,triple_doubles'

/**
 * A Sleeper projected stat line in league points, matching the server's projection_stat_fantasy_points:
 * fractional double/triple-double expectations count as given; without them, 10+ categories decide.
 */
export function sleeperProjectionPoints(row: SleeperProjectionRow, settings: Record<string, number>): number {
    const weight = (key: string) => Number(settings[key] ?? 0) || 0
    const tens = [row.points, row.rebounds, row.assists, row.steals, row.blocks].filter(value => Number(value) >= 10).length
    const total = Number(row.points) * weight('points') + Number(row.rebounds) * weight('rebounds')
        + Number(row.assists) * weight('assists') + Number(row.steals) * weight('steals') + Number(row.blocks) * weight('blocks')
        + Number(row.three_pointers_made) * weight('three_pointers_made') + Number(row.turnovers) * weight('turnovers')
        + Number(row.field_goals_made) * weight('field_goals_made') + Number(row.field_goals_attempted) * weight('field_goals_attempted')
        + Number(row.free_throws_made) * weight('free_throws_made') + Number(row.free_throws_attempted) * weight('free_throws_attempted')
        + Number(row.double_doubles ?? (tens >= 2 ? 1 : 0)) * weight('double_double')
        + Number(row.triple_doubles ?? (tens >= 3 ? 1 : 0)) * weight('triple_double')
    return Math.round(total * 100) / 100
}

/**
 * Sleeper fantasy projections for these players on one date, in this league's scoring. Like the server, a row
 * counts only for the player's current team, so a traded player's old-team game never shows.
 */
export async function getDayProjections(leagueId: string, date: string, players: { playerId: string; nbaTeam: string | null }[],
    settings: Record<string, number>): Promise<Map<string, number>> {
    const teams = new Map(players.filter(player => player.playerId && player.nbaTeam).map(player => [player.playerId, player.nbaTeam!]))
    const ids = [...teams.keys()].sort()
    if (ids.length === 0) return new Map()
    const [{ readLeagueDaily }, { supabase }] = await Promise.all([import('@/lib/league-daily-cache'), import('@/lib/supabase')])
    const rows = await readLeagueDaily(leagueId, JSON.stringify(['sleeper-day-projections', date, ids]), async () => {
        const { data, error } = await supabase.from('sleeper_projection_rows').select(SLEEPER_COLUMNS).eq('game_date', date).in('player_id', ids)
        if (error) throw error
        return (data ?? []) as unknown as SleeperProjectionRow[]
    })
    const latest = new Map<string, SleeperProjectionRow>()
    for (const row of rows) {
        if (row.game_date !== date || teams.get(row.player_id) !== row.team) continue
        const seen = latest.get(row.player_id)
        if (!seen || Number(row.last_modified) > Number(seen.last_modified)) latest.set(row.player_id, row)
    }
    return new Map([...latest].map(([playerId, row]) => [playerId, sleeperProjectionPoints(row, settings)]))
}

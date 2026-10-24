import { readLeagueDaily } from '@/lib/league-daily-cache'
import { supabase } from '@/lib/supabase'
import { currentSeasonYear } from '@/lib/shared/season'
import { todayET } from '@/lib/shared/dates'

type ProjectionView = 'today' | 'week_avg' | 'week_total'

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

async function getLeagueProjections({
    leagueId,
    view = 'today',
    seasonYear = currentSeasonYear(),
    gameDate = todayET(),
    playerIds = null,
    limit = 600,
    offset = 0,
}: {
    leagueId: string
    view?: ProjectionView
    seasonYear?: number
    gameDate?: string
    playerIds?: string[] | null
    limit?: number
    offset?: number
}): Promise<LeagueProjectionRow[]> {
    return readLeagueDaily(leagueId, JSON.stringify(['projections', seasonYear, gameDate, view, playerIds?.slice().sort() ?? null, limit, offset]), async () => {
        const { data, error } = await supabase.rpc('get_league_projection_rows', {
            p_league_id: leagueId,
            p_season_year: seasonYear,
            p_game_date: gameDate,
            p_view: view,
            p_player_ids: playerIds ?? undefined,
            p_limit: limit,
            p_offset: offset,
        })
        if (error) throw error
        return (data ?? []) as LeagueProjectionRow[]
    })
}

export async function getPlayerProjection(
    playerId: string,
    leagueId: string,
    seasonYear = currentSeasonYear(),
    gameDate = todayET(),
): Promise<LeagueProjectionRow | null> {
    const rows = await getLeagueProjections({
        leagueId,
        view: 'today',
        seasonYear,
        gameDate,
        playerIds: [playerId],
        limit: 1,
    })
    return rows[0] ?? null
}

export async function getProjectionMap({
    leagueId,
    seasonYear,
    gameDate,
    playerIds,
}: {
    leagueId: string
    seasonYear: number
    gameDate: string
    playerIds: string[]
}): Promise<Map<string, LeagueProjectionRow>> {
    if (playerIds.length === 0) return new Map()
    const rows = await getLeagueProjections({
        leagueId,
        view: 'today',
        seasonYear,
        gameDate,
        playerIds,
        limit: Math.min(Math.max(playerIds.length, 1), 1000),
    })
    return new Map(rows.map((row) => [row.player_id, row]))
}

export function formatProjectionGame(row: Pick<LeagueProjectionRow, 'projection_date' | 'next_game_date' | 'next_game_opponent'>): string {
    const opponent = row.next_game_opponent
    const date = row.projection_date ?? row.next_game_date
    if (opponent && date) return `${opponent} ${shortDate(date)}`
    if (opponent) return opponent
    if (date) return shortDate(date)
    return ''
}

export function numberOrDash(value: number | null | undefined, digits = 1): string {
    if (value == null || !Number.isFinite(Number(value))) return '-'
    return Number(value).toFixed(digits)
}

function shortDate(date: string): string {
    const parsed = new Date(`${date}T12:00:00Z`)
    if (!Number.isFinite(parsed.getTime())) return date
    return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

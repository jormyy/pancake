import { supabase } from '@/lib/supabase'
import { currentSeasonYear } from '@/lib/shared/season'
import { todayET } from '@/lib/shared/dates'

export type ProjectionView = 'today' | 'week_avg' | 'week_total'

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

export async function getLeagueProjections({
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

export function projectionFreshnessLabel(fetchedAt: string | null | undefined): string {
    if (!fetchedAt) return ''
    const ageMs = Date.now() - new Date(fetchedAt).getTime()
    if (!Number.isFinite(ageMs) || ageMs < 0) return 'fresh'
    const minutes = Math.floor(ageMs / 60000)
    if (minutes < 60) return `${Math.max(1, minutes)}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 48) return `${hours}h`
    return `${Math.floor(hours / 24)}d`
}

export function projectionViewLabel(view: string | null | undefined): string {
    switch (view) {
        case 'today':
            return 'Today'
        case 'week_avg':
            return 'Week Avg'
        case 'week_total':
            return 'Week Total'
        case 'fallback':
            return 'Fallback'
        default:
            return ''
    }
}

export function compactProjectionStatLine(row: Pick<
    LeagueProjectionRow,
    'projection_points' | 'projection_rebounds' | 'projection_assists' | 'projection_steals' | 'projection_blocks' | 'projection_three_pointers_made' | 'projection_turnovers'
>): string {
    const parts = [
        numberPart(row.projection_points, 'PTS'),
        numberPart(row.projection_rebounds, 'REB'),
        numberPart(row.projection_assists, 'AST'),
        numberPart(row.projection_steals, 'STL'),
        numberPart(row.projection_blocks, 'BLK'),
        numberPart(row.projection_three_pointers_made, '3PM'),
        numberPart(row.projection_turnovers, 'TO'),
    ].filter(Boolean)
    return parts.join(' / ')
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

function numberPart(value: number | null | undefined, label: string): string | null {
    if (value == null || !Number.isFinite(Number(value))) return null
    return `${Number(value).toFixed(1)} ${label}`
}

function shortDate(date: string): string {
    const parsed = new Date(`${date}T12:00:00Z`)
    if (!Number.isFinite(parsed.getTime())) return date
    return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

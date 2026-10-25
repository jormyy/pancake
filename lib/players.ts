import { calculateFantasyPoints, snakeToStatLine, roundFantasyPoints, type ScoringSettings } from '@pancake/core'
import { supabase } from '@/lib/supabase'
import type { Database } from '@/types/database'
import { currentSeasonYear } from '@/lib/shared/season'
import { TRANSACTION_LABELS } from '@/lib/shared/transaction-labels'
import {
    type PlayerSearchSortDir,
    type PlayerSearchSortMode,
} from '@/lib/player-search-sort'

/** Resolves a player's eligible positions, falling back to the primary position. */
export function getEligiblePositions(player: { eligible_positions?: string[] | null; position?: string | null }): string[] {
    if (player.eligible_positions?.length) return player.eligible_positions as string[]
    return player.position ? [player.position] : []
}

export type PlayerRow = {
    id: string
    display_name: string
    nba_team: string | null
    position: string | null
    eligible_positions: string[]
    status: string | null
    injury_status: string | null
    headshot_url: string | null
    nba_id: string | null
    years_exp: number | null
    career_regular_season_games?: number | null
    playing_now?: boolean
    stats_season_year?: number | null
    avg_fantasy_points?: number | null
    avg_points?: number | null
    avg_rebounds?: number | null
    avg_assists?: number | null
    avg_steals?: number | null
    avg_blocks?: number | null
    avg_turnovers?: number | null
    avg_three_pointers_made?: number | null
    avg_minutes_played?: number | null
    games_played?: number | null
    projection_fantasy_points?: number | null
    projection_source?: string | null
    projection_source_label?: string | null
    projection_view?: string | null
    projection_fetched_at?: string | null
    projection_date?: string | null
    projection_opponent?: string | null
    projection_minutes?: number | null
    projection_points?: number | null
    projection_rebounds?: number | null
    projection_assists?: number | null
    projection_steals?: number | null
    projection_blocks?: number | null
    projection_three_pointers_made?: number | null
    projection_turnovers?: number | null
    projection_games_played?: number | null
    projection_status?: string | null
}

type PlayerTableRow = Database['public']['Tables']['players']['Row']
type RosterTransactionRow = Database['public']['Tables']['roster_transactions']['Row']
type SearchPlayersRow = Database['public']['Functions']['search_players']['Returns'][number]

type PlayerDetailSourceRow = Pick<
    PlayerTableRow,
    | 'id'
    | 'display_name'
    | 'first_name'
    | 'last_name'
    | 'nba_team'
    | 'position'
    | 'eligible_positions'
    | 'jersey_number'
    | 'injury_status'
    | 'dynasty_rank'
    | 'headshot_url'
    | 'nba_id'
    | 'years_exp'
    | 'career_regular_season_games'
    | 'status'
>

export type PlayerDetailRow = PlayerDetailSourceRow & {
    display_name: string
}

type TransactionHistoryRow = Pick<
    RosterTransactionRow,
    'id' | 'transaction_type' | 'occurred_at'
> & {
    league_members: { team_name: string | null } | null
}
const PLAYER_DETAIL_SELECT = `
    id,
    display_name,
    first_name,
    last_name,
    nba_team,
    position,
    eligible_positions,
    jersey_number,
    injury_status,
    dynasty_rank,
    headshot_url,
    nba_id,
    years_exp,
    career_regular_season_games,
    status
`

export type PlayerSeasonAverages = {
    gamesPlayed: number
    avgPoints: number
    avgRebounds: number
    avgAssists: number
    avgSteals: number
    avgBlocks: number
    avgTurnovers: number
    avgThreePointersMade: number
    avgFieldGoalsMade: number
    avgFieldGoalsAttempted: number
    avgFreeThrowsMade: number
    avgFreeThrowsAttempted: number
    avgMinutesPlayed: number
    doubleDoubles: number
    tripleDoubles: number
}

export type GameLogEntry = {
    gameId: string
    gameDate: string
    opponent: string
    isHome: boolean
    didNotPlay: boolean
    minutes: number
    points: number
    rebounds: number
    assists: number
    steals: number
    blocks: number
    turnovers: number
    personalFouls: number
    fgMade: number
    fgAttempted: number
    threeMade: number
    threeAttempted: number
    ftMade: number
    ftAttempted: number
    plusMinus: number
    doubleDouble: boolean
    tripleDouble: boolean
}

export type TransactionHistoryEntry = {
    id: string
    transactionType: string
    label: string
    teamName: string
    occurredAt: string
}

type PlayerHealthFilter = 'all' | 'healthy' | 'gtd' | 'out' | 'ir'
type PlayerSearchQueryConstraints = {
    includePlayerIds?: string[]
    excludePlayerIds?: string[]
    excludedTeams?: string[]
}
type PlayerSearchOptions = {
    sortMode?: PlayerSearchSortMode
    sortDir?: PlayerSearchSortDir
    pageSize?: number
    seasonYear?: number | null
}

const DEFAULT_PLAYER_SEARCH_PAGE_SIZE = 20

function uniqueNonEmpty(values?: string[]): string[] {
    return Array.from(new Set((values ?? []).filter(Boolean)))
}

function mapSearchPlayer(row: SearchPlayersRow): PlayerRow {
    return { ...row }
}

function mapPlayerDetail(row: PlayerDetailSourceRow): PlayerDetailRow {
    const fallbackName = `${row.first_name} ${row.last_name}`.trim() || 'Unknown Player'
    return {
        ...row,
        display_name: row.display_name ?? fallbackName,
    }
}

export async function searchPlayers(
    query: string,
    position: string,
    teams: string[],
    leagueId?: string | null,
    playingTeams?: string[] | null,
    rookiesOnly = false,
    offset = 0,
    health: PlayerHealthFilter = 'all',
    constraints: PlayerSearchQueryConstraints = {},
    sortByOrOptions: PlayerSearchSortMode | PlayerSearchOptions = 'fpts',
    sortDirArg: PlayerSearchSortDir = 'desc',
): Promise<PlayerRow[]> {
    const hasSearchOptions = typeof sortByOrOptions === 'object' && sortByOrOptions !== null
    const season = (hasSearchOptions ? sortByOrOptions.seasonYear : null) ?? undefined
    const sortBy = hasSearchOptions ? (sortByOrOptions.sortMode ?? 'fpts') : sortByOrOptions
    const sortDir = hasSearchOptions ? (sortByOrOptions.sortDir ?? 'desc') : sortDirArg
    const pageSize = hasSearchOptions ? (sortByOrOptions.pageSize ?? DEFAULT_PLAYER_SEARCH_PAGE_SIZE) : DEFAULT_PLAYER_SEARCH_PAGE_SIZE
    const includePlayerIds = constraints.includePlayerIds == null ? undefined : uniqueNonEmpty(constraints.includePlayerIds)

    const { data, error } = await supabase.rpc('search_players', {
        p_query: query,
        p_position: position,
        p_teams: uniqueNonEmpty(teams),
        p_league_id: leagueId ?? undefined,
        p_playing_teams: playingTeams == null ? undefined : uniqueNonEmpty(playingTeams),
        p_excluded_teams: uniqueNonEmpty(constraints.excludedTeams),
        p_include_player_ids: includePlayerIds,
        p_exclude_player_ids: uniqueNonEmpty(constraints.excludePlayerIds),
        p_rookies_only: rookiesOnly,
        p_health: health,
        p_sort_by: sortBy,
        p_sort_dir: sortDir,
        p_season_year: season,
        p_limit: pageSize,
        p_offset: offset,
    })
    if (error) throw error
    return (data ?? []).map(mapSearchPlayer)
}


export async function getPlayer(id: string): Promise<PlayerDetailRow> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw new Error('Player not found.')
    }
    const { data, error } = await supabase
        .from('players')
        .select(PLAYER_DETAIL_SELECT)
        .eq('id', id)
        .maybeSingle()
    if (error) throw error
    if (!data) throw new Error('Player not found.')
    return mapPlayerDetail(data)
}

export async function getAvailableSeasons(playerId: string): Promise<number[]> {
    const { data, error } = await supabase
        .from('mv_player_season_averages')
        .select('season_year')
        .eq('player_id', playerId)
        .order('season_year', { ascending: false })

    if (error) throw error
    if (!data || data.length === 0) return [currentSeasonYear()]

    return data.map((r) => r.season_year).filter((year): year is number => year != null)
}

export async function getPlayerTransactionHistory(
    playerId: string,
    leagueId: string,
    limit = 20,
    offset = 0,
): Promise<TransactionHistoryEntry[]> {
    const { data, error } = await supabase
        .from('roster_transactions')
        .select(`
            id,
            transaction_type,
            occurred_at,
            league_members!roster_transactions_member_id_fkey ( team_name )
        `)
        .eq('player_id', playerId)
        .eq('league_id', leagueId)
        .order('occurred_at', { ascending: false })
        .range(offset, offset + limit - 1)

    if (error) throw error

    const rows = (data ?? []) as TransactionHistoryRow[]
    return rows.map((row) => ({
        id: row.id,
        transactionType: row.transaction_type,
        label: TRANSACTION_LABELS[row.transaction_type] ?? row.transaction_type,
        teamName: row.league_members?.team_name ?? 'Unknown',
        occurredAt: row.occurred_at,
    }))
}

type VisiblePlayerTotalsRow = Database['public']['Functions']['get_visible_player_totals']['Returns'][number]
export type VisiblePlayerTotals = Omit<VisiblePlayerTotalsRow, 'rounded_fantasy_average' | 'game_status' | 'game_time' | 'started_at'> & {
    rounded_fantasy_average: number | null
    game_status: string | null
    game_time: string | null
    started_at: string | null
}

export async function getVisiblePlayerTotals(leagueId: string, playerIds: string[], seasonYear: number): Promise<VisiblePlayerTotals[]> {
    if (!playerIds.length) return []
    if (playerIds.length > 50) throw new Error('Choose at most 50 visible players.')
    const { data, error } = await supabase.rpc('get_visible_player_totals', {
        p_league_id: leagueId, p_player_ids: playerIds, p_season_year: seasonYear,
    })
    if (error) throw error
    return data ?? []
}

export function applyVisiblePlayerTotals(player: PlayerRow, row: VisiblePlayerTotals, scoring: ScoringSettings | null, now = Date.now()): PlayerRow {
    const totals = row.totals
    if (!totals || typeof totals !== 'object' || Array.isArray(totals)) return player
    const value = (key: string) => Number(totals[key]) || 0
    const games = value('games_played')
    const average = (key: string) => value(`${key}_count`) ? value(key) / value(`${key}_count`) : null
    const line = Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, Number(value) || 0]))
    const totalFP = scoring ? roundFantasyPoints(calculateFantasyPoints(snakeToStatLine({ ...line, double_double: false, triple_double: false }), scoring)
        + value('double_double') * (scoring.double_double ?? 0) + value('triple_double') * (scoring.triple_double ?? 0)) : null
    const status = row.game_status?.toLowerCase().replaceAll('_', '')
    const tipoff = row.started_at ?? row.game_time
    return {
        ...player,
        games_played: games,
        avg_fantasy_points: row.rounded_fantasy_average ?? (totalFP != null && games ? roundFantasyPoints(totalFP / games) : null),
        avg_points: average('points'), avg_rebounds: average('rebounds'), avg_assists: average('assists'),
        avg_steals: average('steals'), avg_blocks: average('blocks'), avg_turnovers: average('turnovers'),
        avg_three_pointers_made: average('three_pointers_made'), avg_minutes_played: average('minutes_played'),
        playing_now: status === 'inprogress' || (status === 'scheduled' && tipoff != null && Date.parse(tipoff) <= now),
    }
}

export type PlayerSeasonLine = Pick<Database['public']['Tables']['player_game_stats']['Row'],
    'id'
    | 'game_date'
    | 'did_not_play'
    | 'minutes_played'
    | 'points'
    | 'rebounds'
    | 'assists'
    | 'steals'
    | 'blocks'
    | 'turnovers'
    | 'personal_fouls'
    | 'field_goals_made'
    | 'field_goals_attempted'
    | 'three_pointers_made'
    | 'three_pointers_attempted'
    | 'free_throws_made'
    | 'free_throws_attempted'
    | 'plus_minus'
    | 'double_double'
    | 'triple_double'> & {
    is_home?: boolean | null
    nba_games: Pick<Database['public']['Tables']['nba_games']['Row'],
        'id' | 'nba_game_id' | 'game_date' | 'home_team' | 'away_team' | 'status' | 'game_time' | 'started_at'>
}

export async function getPlayerSeasonLines(playerId: string, seasonYear: number): Promise<PlayerSeasonLine[]> {
    const { data, error } = await supabase.from('player_game_stats')
        .select(`id, game_date, is_home, did_not_play, minutes_played,
            points, rebounds, assists, steals, blocks, turnovers, personal_fouls,
            field_goals_made, field_goals_attempted, three_pointers_made, three_pointers_attempted,
            free_throws_made, free_throws_attempted, plus_minus, double_double, triple_double,
            nba_games!inner(id, nba_game_id, game_date, home_team, away_team, status, game_time, started_at)`)
        .eq('player_id', playerId)
        .eq('season_year', seasonYear)
        .like('nba_games.nba_game_id', '002%')
        .order('game_date', { ascending: false })
        .limit(100)
        .returns<PlayerSeasonLine[]>()
    if (error) throw error
    return data ?? []
}

export async function getPlayerRowMetadata(playerIds: string[]) {
    if (playerIds.length === 0) return new Map<string, { nba_team: string | null; injury_status: string | null; years_exp: number | null; career_regular_season_games: number | null }>()
    const { data, error } = await supabase.from('players')
        .select('id, nba_team, injury_status, years_exp, career_regular_season_games')
        .in('id', [...new Set(playerIds)])
    if (error) throw error
    return new Map((data ?? []).map(player => [player.id, player]))
}

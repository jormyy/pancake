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
type PlayerGameStatsRow = Database['public']['Tables']['player_game_stats']['Row']
type NbaGameRow = Database['public']['Tables']['nba_games']['Row']
type FantasyPointsRow = Database['public']['Views']['v_fantasy_points']['Row']
type PlayerSeasonAverageRow = Database['public']['Views']['mv_player_season_averages']['Row']
type FantasyPointValueRow = Pick<FantasyPointsRow, 'stat_id' | 'fantasy_points'>
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
    | 'status'
>

export type PlayerDetailRow = PlayerDetailSourceRow & {
    display_name: string
}

type PlayerGameLogRow = Pick<
    PlayerGameStatsRow,
    | 'id'
    | 'points'
    | 'rebounds'
    | 'offensive_rebounds'
    | 'defensive_rebounds'
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
    | 'triple_double'
    | 'did_not_play'
    | 'minutes_played'
> & {
    nba_games: Pick<NbaGameRow, 'id' | 'nba_game_id' | 'game_date' | 'home_team' | 'away_team'> | null
}

type TransactionHistoryRow = Pick<
    RosterTransactionRow,
    'id' | 'transaction_type' | 'occurred_at'
> & {
    league_members: { team_name: string | null } | null
}
type PlayerSeasonAverageSourceRow = Pick<
    PlayerSeasonAverageRow,
    | 'games_played'
    | 'avg_points'
    | 'avg_rebounds'
    | 'avg_assists'
    | 'avg_steals'
    | 'avg_blocks'
    | 'avg_turnovers'
    | 'avg_three_pointers_made'
    | 'avg_field_goals_made'
    | 'avg_field_goals_attempted'
    | 'avg_free_throws_made'
    | 'avg_free_throws_attempted'
    | 'avg_minutes_played'
    | 'double_doubles'
    | 'triple_doubles'
>

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
    status
`

const PLAYER_SEASON_AVERAGE_SELECT = `
    games_played,
    avg_points,
    avg_rebounds,
    avg_assists,
    avg_steals,
    avg_blocks,
    avg_turnovers,
    avg_three_pointers_made,
    avg_field_goals_made,
    avg_field_goals_attempted,
    avg_free_throws_made,
    avg_free_throws_attempted,
    avg_minutes_played,
    double_doubles,
    triple_doubles
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

export type PlayerHealthFilter = 'all' | 'healthy' | 'gtd' | 'out' | 'ir'
export type PlayerSearchQueryConstraints = {
    includePlayerIds?: string[]
    excludePlayerIds?: string[]
    excludedTeams?: string[]
}
export type PlayerSearchOptions = {
    sortMode?: PlayerSearchSortMode
    sortDir?: PlayerSearchSortDir
    pageSize?: number
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

function mapPlayerSeasonAverages(row: PlayerSeasonAverageSourceRow): PlayerSeasonAverages {
    return {
        gamesPlayed: Number(row.games_played) || 0,
        avgPoints: Number(row.avg_points) || 0,
        avgRebounds: Number(row.avg_rebounds) || 0,
        avgAssists: Number(row.avg_assists) || 0,
        avgSteals: Number(row.avg_steals) || 0,
        avgBlocks: Number(row.avg_blocks) || 0,
        avgTurnovers: Number(row.avg_turnovers) || 0,
        avgThreePointersMade: Number(row.avg_three_pointers_made) || 0,
        avgFieldGoalsMade: Number(row.avg_field_goals_made) || 0,
        avgFieldGoalsAttempted: Number(row.avg_field_goals_attempted) || 0,
        avgFreeThrowsMade: Number(row.avg_free_throws_made) || 0,
        avgFreeThrowsAttempted: Number(row.avg_free_throws_attempted) || 0,
        avgMinutesPlayed: Number(row.avg_minutes_played) || 0,
        doubleDoubles: Number(row.double_doubles) || 0,
        tripleDoubles: Number(row.triple_doubles) || 0,
    }
}

function hasFantasyStatId(row: FantasyPointValueRow): row is FantasyPointValueRow & { stat_id: string } {
    return row.stat_id != null
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
    const season = currentSeasonYear()
    const hasSearchOptions = typeof sortByOrOptions === 'object' && sortByOrOptions !== null
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
    const { data, error } = await supabase
        .from('players')
        .select(PLAYER_DETAIL_SELECT)
        .eq('id', id)
        .single()
    if (error) throw error
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

export async function getPlayerSeasonAveragesFromView(
    playerId: string,
    seasonYear: number,
): Promise<PlayerSeasonAverages | null> {
    const { data, error } = await supabase
        .from('mv_player_season_averages')
        .select(PLAYER_SEASON_AVERAGE_SELECT)
        .eq('player_id', playerId)
        .eq('season_year', seasonYear)
        .maybeSingle()

    if (error) throw error
    if (!data) return null
    return mapPlayerSeasonAverages(data)
}

export async function getPlayerGameLog(
    playerId: string,
    playerTeam: string | null,
    seasonYear: number,
    limit = 15,
    offset = 0,
): Promise<{ games: GameLogEntry[]; hasMore: boolean }> {
    const fetchLimit = limit + 1

    const { data, error } = await supabase
        .from('player_game_stats')
        .select(`
            id,
            points, rebounds, offensive_rebounds, defensive_rebounds,
            assists, steals, blocks, turnovers, personal_fouls,
            field_goals_made, field_goals_attempted,
            three_pointers_made, three_pointers_attempted,
            free_throws_made, free_throws_attempted,
            plus_minus, double_double, triple_double,
            did_not_play, minutes_played,
            nba_games!inner ( id, nba_game_id, game_date, home_team, away_team )
        `)
        .eq('player_id', playerId)
        .eq('season_year', seasonYear)
        .like('nba_games.nba_game_id', '002%')
        .order('game_date', { ascending: false })
        .range(offset, offset + fetchLimit - 1)

    if (error) throw error

    const rows = (data ?? []) as PlayerGameLogRow[]
    const hasMore = rows.length > limit
    const games = rows.slice(0, limit).map((g): GameLogEntry => {
        const game = g.nba_games
        const isHome = playerTeam ? game?.home_team === playerTeam : false
        const opponent = isHome
            ? `vs ${game?.away_team ?? '?'}`
            : `@ ${game?.home_team ?? '?'}`

        return {
            gameId: g.id,
            gameDate: game?.game_date ?? '',
            opponent,
            isHome,
            didNotPlay: g.did_not_play ?? false,
            minutes: Number(g.minutes_played) || 0,
            points: g.points ?? 0,
            rebounds: g.rebounds ?? 0,
            assists: g.assists ?? 0,
            steals: g.steals ?? 0,
            blocks: g.blocks ?? 0,
            turnovers: g.turnovers ?? 0,
            personalFouls: g.personal_fouls ?? 0,
            fgMade: g.field_goals_made ?? 0,
            fgAttempted: g.field_goals_attempted ?? 0,
            threeMade: g.three_pointers_made ?? 0,
            threeAttempted: g.three_pointers_attempted ?? 0,
            ftMade: g.free_throws_made ?? 0,
            ftAttempted: g.free_throws_attempted ?? 0,
            plusMinus: g.plus_minus ?? 0,
            doubleDouble: g.double_double ?? false,
            tripleDouble: g.triple_double ?? false,
        }
    })

    return { games, hasMore }
}

export async function getPlayerFantasyPoints(
    playerId: string,
    leagueId: string,
    seasonYear: number,
): Promise<{ gameId: string; fantasyPoints: number }[]> {
    // v_fantasy_points doesn't expose did_not_play and has no auto-detected FK
    // back to player_game_stats, so we can't !inner-filter in one PostgREST
    // call. Run the two scoped queries in parallel — both filter by the same
    // (player_id, season_year), so they're independent. The DNP-id set is
    // small (per player per season) and used to exclude rows the view zeroes
    // out (DNPs would otherwise dilute the per-game average computed upstream).
    const [fantasyRes, dnpRes] = await Promise.all([
        supabase
            .from('v_fantasy_points')
            .select('stat_id, fantasy_points')
            .eq('player_id', playerId)
            .eq('league_id', leagueId)
            .eq('season_year', seasonYear),
        supabase
            .from('player_game_stats')
            .select('id')
            .eq('player_id', playerId)
            .eq('season_year', seasonYear)
            .eq('did_not_play', true),
    ])

    if (fantasyRes.error) throw fantasyRes.error
    if (dnpRes.error) throw dnpRes.error

    const dnpIds = new Set((dnpRes.data ?? []).map((r) => r.id))
    return (fantasyRes.data ?? [])
        .filter((row): row is FantasyPointValueRow & { stat_id: string } => hasFantasyStatId(row) && !dnpIds.has(row.stat_id))
        .map((row) => ({
            gameId: row.stat_id,
            fantasyPoints: Number(row.fantasy_points) || 0,
        }))
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

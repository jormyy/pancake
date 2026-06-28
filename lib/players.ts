import { supabase } from '@/lib/supabase'
import type { NBAPosition } from '@/types/database'
import { currentSeasonYear } from '@/lib/shared/season'
import { TRANSACTION_LABELS } from '@/lib/shared/transaction-labels'
import {
    PLAYER_SORT_MV_COLUMN,
    sortPlayerRows,
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
}

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

type AverageRow = {
    player_id: string | null
    games_played: number | null
    avg_points: number | null
    avg_rebounds: number | null
    avg_assists: number | null
    avg_steals: number | null
    avg_blocks: number | null
    avg_turnovers: number | null
    avg_three_pointers_made: number | null
    avg_minutes_played: number | null
    players?: PlayerRow
}

const AVG_SELECT = 'player_id, games_played, avg_points, avg_rebounds, avg_assists, avg_steals, avg_blocks, avg_turnovers, avg_three_pointers_made, avg_minutes_played'
const PLAYER_SELECT = 'id, display_name, nba_team, position, eligible_positions, status, injury_status, nba_id, years_exp'
const AVG_WITH_PLAYER_SELECT = `${AVG_SELECT}, players!inner(${PLAYER_SELECT})`

function withAverages(player: PlayerRow, averages?: AverageRow, avgFantasyPoints?: number | null): PlayerRow {
    return {
        ...player,
        avg_fantasy_points: avgFantasyPoints ?? player.avg_fantasy_points ?? averages?.avg_points ?? null,
        avg_points: averages?.avg_points ?? player.avg_points ?? null,
        avg_rebounds: averages?.avg_rebounds ?? player.avg_rebounds ?? null,
        avg_assists: averages?.avg_assists ?? player.avg_assists ?? null,
        avg_steals: averages?.avg_steals ?? player.avg_steals ?? null,
        avg_blocks: averages?.avg_blocks ?? player.avg_blocks ?? null,
        avg_turnovers: averages?.avg_turnovers ?? player.avg_turnovers ?? null,
        avg_three_pointers_made: averages?.avg_three_pointers_made ?? player.avg_three_pointers_made ?? null,
        avg_minutes_played: averages?.avg_minutes_played ?? player.avg_minutes_played ?? null,
        games_played: averages?.games_played ?? player.games_played ?? null,
    }
}

function mapAverageRows(rows: AverageRow[]): PlayerRow[] {
    return rows
        .filter((row) => row.players)
        .map((row) => withAverages(row.players!, row, row.avg_points))
}

async function hydrateAverages(
    players: PlayerRow[],
    season: number,
    fantasyPointsById = new Map<string, number | null>(),
): Promise<PlayerRow[]> {
    if (players.length === 0) return players

    const { data } = await supabase
        .from('mv_player_season_averages')
        .select(AVG_SELECT)
        .eq('season_year', season)
        .in('player_id', players.map((player) => player.id))

    const averagesById = new Map<string, AverageRow>()
    for (const row of (data ?? []) as AverageRow[]) {
        if (row.player_id) averagesById.set(row.player_id, row)
    }

    return players.map((player) =>
        withAverages(player, averagesById.get(player.id), fantasyPointsById.get(player.id)),
    )
}

function applyHealthFilter<T>(query: T, column: string, health: PlayerHealthFilter): T {
    const q = query as any
    switch (health) {
        case 'healthy':
            return q.is(column, null)
        case 'gtd':
            return q.in(column, ['GTD', 'DTD', 'Questionable', 'Game Time Decision'])
        case 'out':
            return q.in(column, ['Out', 'OUT', 'O'])
        case 'ir':
            return q.in(column, ['IR', 'IR-LTI'])
        default:
            return query
    }
}

function uniqueNonEmpty(values?: string[]): string[] {
    return Array.from(new Set((values ?? []).filter(Boolean)))
}

function postgresInList(values: string[]): string {
    return `(${values.join(',')})`
}

function applySearchConstraints<T>(
    query: T,
    playerColumnPrefix: 'players.' | '',
    constraints: Required<PlayerSearchQueryConstraints>,
): T {
    const q = query as any
    const includeIds = constraints.includePlayerIds
    const excludeIds = constraints.excludePlayerIds
    const excludedTeams = constraints.excludedTeams
    const idColumn = `${playerColumnPrefix}id`
    const teamColumn = `${playerColumnPrefix}nba_team`

    let next = q
    if (includeIds.length > 0) next = next.in(idColumn, includeIds)
    if (excludeIds.length > 0) next = next.not(idColumn, 'in', postgresInList(excludeIds))
    if (excludedTeams.length > 0) next = next.not(teamColumn, 'in', postgresInList(excludedTeams))
    return next
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
    const pageSize = hasSearchOptions ? (sortByOrOptions.pageSize ?? 60) : 60
    const queryConstraints: Required<PlayerSearchQueryConstraints> = {
        includePlayerIds: uniqueNonEmpty(constraints.includePlayerIds),
        excludePlayerIds: uniqueNonEmpty(constraints.excludePlayerIds),
        excludedTeams: uniqueNonEmpty(constraints.excludedTeams),
    }

    if (constraints.includePlayerIds && queryConstraints.includePlayerIds.length === 0) {
        return []
    }

    // Compute effective team filter: intersect explicit teams + playing-on-day teams
    let effectiveTeams: string[] | null = null
    if (playingTeams != null && teams.length > 0) {
        effectiveTeams = teams.filter((t) => playingTeams.includes(t))
        if (effectiveTeams.length === 0) return []
    } else if (playingTeams != null) {
        effectiveTeams = playingTeams
    } else if (teams.length > 0) {
        effectiveTeams = teams
    }

    // Rookie filter: get rookies with stats (sorted by fantasy pts) + rookies without stats
    if (rookiesOnly) {
        const posFilter: string[] | null = position === 'ALL' ? null
            : position === 'G' ? ['PG', 'SG']
            : position === 'F' ? ['SF', 'PF']
            : [position]

        // 1. Rookies who have stats this season, sorted by avg fantasy pts
        let statsQ = leagueId
            ? supabase
                .from('v_player_avg_fantasy_points')
                .select(`avg_fantasy_points, players!inner(${PLAYER_SELECT})`)
                .eq('league_id', leagueId)
                .eq('season_year', season)
                .filter('players.years_exp', 'eq', 0)
                .order('avg_fantasy_points', { ascending: false })
            : supabase
                .from('mv_player_season_averages')
                .select(AVG_WITH_PLAYER_SELECT)
                .eq('season_year', season)
                .filter('players.years_exp', 'eq', 0)
                .order('avg_points', { ascending: false })

        if (query.trim()) statsQ = statsQ.ilike('players.display_name', `%${query.trim()}%`)
        if (posFilter) statsQ = statsQ.filter('players.eligible_positions', 'ov', `{${posFilter.join(',')}}`)
        if (effectiveTeams != null) statsQ = statsQ.in('players.nba_team', effectiveTeams)
        statsQ = applyHealthFilter(statsQ, 'players.injury_status', health)
        statsQ = applySearchConstraints(statsQ, 'players.', queryConstraints)

        const { data: statsData } = await statsQ
        const withStats = leagueId
            ? await hydrateAverages(
                (statsData ?? []).map((row: any) => row.players) as PlayerRow[],
                season,
                new Map((statsData ?? []).map((row: any) => [row.players.id, Number(row.avg_fantasy_points)])),
            )
            : mapAverageRows((statsData ?? []) as AverageRow[])
        const withStatsIds = new Set(withStats.map((p) => p.id))

        // 2. All rookies (to find those without stats)
        let allQ = supabase
            .from('players')
            .select('id, display_name, nba_team, position, eligible_positions, status, injury_status, nba_id, years_exp')
            .eq('years_exp', 0)
            .order('last_name')

        if (query.trim()) allQ = allQ.ilike('display_name', `%${query.trim()}%`)
        if (posFilter) allQ = allQ.filter('eligible_positions', 'ov', `{${posFilter.join(',')}}`)
        if (effectiveTeams != null) allQ = allQ.in('nba_team', effectiveTeams)
        allQ = applyHealthFilter(allQ, 'injury_status', health)
        allQ = applySearchConstraints(allQ, '', queryConstraints)

        const { data: allData } = await allQ
        const withoutStats = (allData ?? []).filter((p) => !withStatsIds.has(p.id)) as PlayerRow[]

        // The rookie branch returns every rookie unpaginated, so we can honor the
        // chosen stat sort over the full set in memory.
        return sortPlayerRows(
            [...withStats, ...(await hydrateAverages(withoutStats, season))],
            sortBy,
            sortDir,
        )
    }

    const ascending = sortDir === 'asc'
    // Fantasy-points order is the only sort that lives on the per-league scoring
    // view; every other stat lives on the season-averages materialized view, so
    // we order there and overlay this league's FP afterward. Either way the sort
    // is applied to the WHOLE filtered pool server-side, then paginated — so
    // changing the sort re-queries from the top instead of reordering one page.
    const useFantasyOrder = Boolean(leagueId) && sortBy === 'fpts'

    let q = useFantasyOrder
        ? supabase
            .from('v_player_avg_fantasy_points')
            .select(`avg_fantasy_points, players!inner(${PLAYER_SELECT})`)
            .eq('league_id', leagueId!)
            .eq('season_year', season)
            .order('avg_fantasy_points', { ascending, nullsFirst: false })
            .order('player_id', { ascending: true })
            .range(offset, offset + pageSize - 1)
        : supabase
            .from('mv_player_season_averages')
            .select(AVG_WITH_PLAYER_SELECT)
            .eq('season_year', season)
            .order(PLAYER_SORT_MV_COLUMN[sortBy], { ascending })
            .order('player_id', { ascending: true })
            .range(offset, offset + pageSize - 1)

    if (query.trim()) {
        q = q.ilike('players.display_name', `%${query.trim()}%`)
    }
    if (position !== 'ALL') {
        const posFilter: string[] =
            position === 'G' ? ['PG', 'SG']
            : position === 'F' ? ['SF', 'PF']
            : [position]
        q = q.filter('players.eligible_positions', 'ov', `{${posFilter.join(',')}}`)
    }
    if (effectiveTeams != null) {
        q = q.in('players.nba_team', effectiveTeams)
    }
    q = applyHealthFilter(q, 'players.injury_status', health)
    q = applySearchConstraints(q, 'players.', queryConstraints)

    const { data, error } = await q
    if (error) throw error

    // League + fantasy-points order: rows come from the FP view; hydrate stats.
    if (useFantasyOrder) {
        return hydrateAverages(
            (data ?? []).map((row: any) => row.players) as PlayerRow[],
            season,
            new Map((data ?? []).map((row: any) => [row.players.id, Number(row.avg_fantasy_points)])),
        )
    }

    // Stat order (or no league): rows come from the season-averages view.
    const players = mapAverageRows((data ?? []) as AverageRow[])
    if (!leagueId) return players
    // League present but ordered by a raw stat — overlay per-league FP so the FP
    // column still reflects this league's scoring rather than the avg-points proxy.
    return hydrateLeagueFantasyPoints(players, leagueId, season)
}

async function hydrateLeagueFantasyPoints(
    players: PlayerRow[],
    leagueId: string,
    season: number,
): Promise<PlayerRow[]> {
    if (players.length === 0) return players

    const { data } = await supabase
        .from('v_player_avg_fantasy_points')
        .select('player_id, avg_fantasy_points')
        .eq('league_id', leagueId)
        .eq('season_year', season)
        .in('player_id', players.map((player) => player.id))

    const fpById = new Map<string, number>()
    for (const row of (data ?? []) as { player_id: string | null; avg_fantasy_points: number | null }[]) {
        if (row.player_id != null) fpById.set(row.player_id, Number(row.avg_fantasy_points))
    }

    return players.map((player) =>
        fpById.has(player.id) ? { ...player, avg_fantasy_points: fpById.get(player.id)! } : player,
    )
}


export async function getPlayer(id: string) {
    const { data, error } = await supabase.from('players').select('*').eq('id', id).single()
    if (error) throw error
    return data
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
        .select('*')
        .eq('player_id', playerId)
        .eq('season_year', seasonYear)
        .single()

    if (error || !data) return null
    const row = data

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

    const rows = data ?? []
    const hasMore = rows.length > limit
    const games = rows.slice(0, limit).map((g: any): GameLogEntry => {
        const game = g.nba_games ?? {}
        const isHome = playerTeam ? game.home_team === playerTeam : false
        const opponent = isHome
            ? `vs ${game.away_team ?? '?'}`
            : `@ ${game.home_team ?? '?'}`

        return {
            gameId: g.id,
            gameDate: game.game_date ?? '',
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
        .filter((r: any) => r.stat_id != null && !dnpIds.has(r.stat_id))
        .map((r: any) => ({
            gameId: r.stat_id,
            fantasyPoints: Number(r.fantasy_points) || 0,
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

    return (data ?? []).map((row: any) => ({
        id: row.id,
        transactionType: row.transaction_type,
        label: TRANSACTION_LABELS[row.transaction_type] ?? row.transaction_type,
        teamName: row.league_members?.team_name ?? 'Unknown',
        occurredAt: row.occurred_at,
    }))
}

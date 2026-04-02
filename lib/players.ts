import { supabase } from '@/lib/supabase'
import type { NBAPosition } from '@/types/database'
import { currentSeasonYear } from '@/lib/shared/season'
import { TRANSACTION_LABELS } from '@/lib/transactions'

export type PlayerRow = {
    id: string
    display_name: string
    nba_team: string | null
    position: string | null
    status: string | null
    injury_status: string | null
    headshot_url: string | null
    nba_id: string | null
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

export async function searchPlayers(query: string, position: string): Promise<PlayerRow[]> {
    // Primary: players with stats this season, ranked by avg points descending
    let q = supabase
        .from('mv_player_season_averages')
        .select('avg_points, players!inner(id, display_name, nba_team, position, status, injury_status, nba_id)')
        .eq('season_year', currentSeasonYear())
        .order('avg_points', { ascending: false })
        .limit(60)

    if (query.trim()) {
        q = q.ilike('players.display_name', `%${query.trim()}%`)
    }
    if (position !== 'ALL') {
        q = q.eq('players.position', position as NBAPosition)
    }

    const { data, error } = await q
    if (error) throw error

    return (data ?? []).map((row: any) => row.players) as PlayerRow[]
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

    return (data as any[]).map((r) => r.season_year as number)
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
    const row = data as any

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
            nba_games ( id, game_date, home_team, away_team )
        `)
        .eq('player_id', playerId)
        .eq('season_year', seasonYear)
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
    // Only include games actually played — DNP rows in v_fantasy_points have 0 pts
    // and would dilute the per-game average.
    const { data: playedRows, error: e1 } = await supabase
        .from('player_game_stats')
        .select('id')
        .eq('player_id', playerId)
        .eq('season_year', seasonYear)
        .eq('did_not_play', false)

    if (e1) throw e1
    if (!playedRows || playedRows.length === 0) return []

    const playedIds = (playedRows as any[]).map((r) => r.id)

    const { data, error } = await supabase
        .from('v_fantasy_points')
        .select('stat_id, fantasy_points')
        .eq('player_id', playerId)
        .eq('league_id', leagueId)
        .eq('season_year', seasonYear)
        .in('stat_id', playedIds)

    if (error) throw error
    return (data ?? []).map((r: any) => ({
        gameId: r.stat_id,
        fantasyPoints: Number(r.fantasy_points) || 0,
    }))
}

export async function getPlayerTransactionHistory(
    playerId: string,
    leagueId: string,
): Promise<TransactionHistoryEntry[]> {
    const { data, error } = await (supabase as any)
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
        .limit(20)

    if (error) throw error

    return (data ?? []).map((row: any) => ({
        id: row.id,
        transactionType: row.transaction_type,
        label: TRANSACTION_LABELS[row.transaction_type] ?? row.transaction_type,
        teamName: row.league_members?.team_name ?? 'Unknown',
        occurredAt: row.occurred_at,
    }))
}


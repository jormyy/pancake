import { supabase } from '@/lib/supabase'
import type { NBAPosition } from '@/types/database'
import { currentSeasonYear } from '@/lib/shared/season'

export type PlayerRow = {
    id: string
    display_name: string
    nba_team: string | null
    position: string | null
    status: string | null
    injury_status: string | null
    headshot_url: string | null
}

export async function searchPlayers(query: string, position: string): Promise<PlayerRow[]> {
    // Primary: players with stats this season, ranked by avg points descending
    let q = supabase
        .from('mv_player_season_averages')
        .select('avg_points, players!inner(id, display_name, nba_team, position, status, injury_status, headshot_url)')
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

export async function getPlayerSeasonAverages(playerId: string) {
    const { data, error } = await supabase
        .from('player_game_stats')
        .select(
            'points, rebounds, assists, steals, blocks, turnovers, three_pointers_made, minutes_played',
        )
        .eq('player_id', playerId)
        .eq('season_year', currentSeasonYear())
        .eq('did_not_play', false)

    if (error) throw error
    if (!data || data.length === 0) return null

    const n = data.length
    const sum = (key: keyof (typeof data)[0]) =>
        data.reduce((acc, g) => acc + (Number(g[key]) || 0), 0)

    return {
        games: n,
        points: sum('points') / n,
        rebounds: sum('rebounds') / n,
        assists: sum('assists') / n,
        steals: sum('steals') / n,
        blocks: sum('blocks') / n,
        turnovers: sum('turnovers') / n,
        threesMade: sum('three_pointers_made') / n,
        minutes: sum('minutes_played') / n,
    }
}

export async function getPlayerRecentGames(playerId: string) {
    const { data, error } = await supabase
        .from('player_game_stats')
        .select(
            `
      points, rebounds, assists, steals, blocks, turnovers,
      three_pointers_made, minutes_played, did_not_play,
      nba_games ( game_date, home_team, away_team )
    `,
        )
        .eq('player_id', playerId)
        .eq('season_year', currentSeasonYear())
        .order('nba_games(game_date)', { ascending: false })
        .limit(5)

    if (error) throw error
    return data ?? []
}

import { supabase } from '@/lib/supabase'

const CURRENT_SEASON =
    new Date().getMonth() >= 9 ? new Date().getFullYear() + 1 : new Date().getFullYear()

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
    let q = supabase
        .from('players')
        .select('id, display_name, nba_team, position, status, injury_status, headshot_url')
        .order('last_name')
        .limit(60)

    if (query.trim()) {
        q = q.ilike('display_name', `%${query.trim()}%`)
    }
    if (position !== 'ALL') {
        q = q.eq('position', position)
    }

    const { data, error } = await q
    if (error) throw error
    return (data ?? []) as PlayerRow[]
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
        .eq('season_year', CURRENT_SEASON)
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
        .eq('season_year', CURRENT_SEASON)
        .order('nba_games(game_date)', { ascending: false })
        .limit(5)

    if (error) throw error
    return data ?? []
}

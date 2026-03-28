import { supabase } from '@/lib/supabase'

export type NBAGameRow = {
    id: string
    nba_game_id: string | null
    home_team: string
    away_team: string
    home_score: number
    away_score: number
    status: string        // 'Scheduled' | 'InProgress' | 'Final'
    game_status_text: string | null  // 'Q3 5:23' | 'Halftime' | 'Final' | '7:30 pm ET'
    game_date: string
}

export async function getTodaysGames(): Promise<NBAGameRow[]> {
    const today = new Date().toISOString().split('T')[0]
    const { data, error } = await supabase
        .from('nba_games')
        .select('id, nba_game_id, home_team, away_team, home_score, away_score, status, game_status_text, game_date')
        .eq('game_date', today)
        .order('status', { ascending: true }) // Final → InProgress → Scheduled

    if (error) throw error
    return (data ?? []) as unknown as NBAGameRow[]
}

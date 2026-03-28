import { supabase } from '@/lib/supabase'

/**
 * Returns the current/most-recent week number for a given NBA season year.
 * Looks for the latest game_date <= today. Returns null if no games found.
 */
export async function getCurrentWeekNumber(seasonYear: number): Promise<number | null> {
    const today = new Date().toISOString().split('T')[0]
    const { data } = await supabase
        .from('nba_games')
        .select('week_number')
        .eq('season_year', seasonYear)
        .lte('game_date', today)
        .order('game_date', { ascending: false })
        .limit(1)
        .maybeSingle()
    return data?.week_number ?? null
}

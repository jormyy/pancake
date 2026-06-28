import { supabase } from '@/lib/supabase'
export { currentSeasonYear } from '@pancake/core'

/**
 * Fetches the current league season (id + season_year).
 */
export async function getCurrentSeason(
    leagueId: string,
): Promise<{ id: string; seasonYear: number } | null> {
    const { data, error } = await supabase
        .from('league_seasons')
        .select('id, season_year')
        .eq('league_id', leagueId)
        .eq('is_current', true)
        .maybeSingle()
    if (error) throw error
    return data ? { id: data.id, seasonYear: data.season_year } : null
}

/**
 * Convenience wrapper — returns just the season id or null.
 */
export async function getCurrentSeasonId(leagueId: string): Promise<string | null> {
    const season = await getCurrentSeason(leagueId)
    return season?.id ?? null
}

/**
 * Like getCurrentSeasonId but falls back to the most recent season when
 * no season is marked is_current (e.g. during the offseason).
 */
export async function getActiveSeasonId(leagueId: string): Promise<string | null> {
    const current = await getCurrentSeasonId(leagueId)
    if (current) return current
    const { data, error } = await supabase
        .from('league_seasons')
        .select('id')
        .eq('league_id', leagueId)
        .order('season_year', { ascending: false })
        .limit(1)
        .maybeSingle()
    if (error) throw error
    return data?.id ?? null
}

import { supabase } from '../supabase'

/**
 * Returns the current NBA season year.
 * The NBA season that starts in Oct 2025 is the "2026" season.
 */
export function currentSeasonYear(): number {
    const now = new Date()
    return now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear()
}

/**
 * Fetches the current league season row (id + season_year).
 * Returns null if no active season exists.
 */
export async function getCurrentSeason(
    leagueId: string,
): Promise<{ id: string; seasonYear: number } | null> {
    const { data, error } = await supabase
        .from('league_seasons')
        .select('id, season_year')
        .eq('league_id', leagueId)
        .eq('is_current', true)
        .single()
    if (error || !data) return null
    return { id: data.id, seasonYear: data.season_year }
}

/**
 * Convenience wrapper — returns just the season id or null.
 */
export async function getCurrentSeasonId(leagueId: string): Promise<string | null> {
    const season = await getCurrentSeason(leagueId)
    return season?.id ?? null
}

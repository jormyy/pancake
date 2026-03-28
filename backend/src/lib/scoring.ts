import { supabase } from './supabase'

export function calculateFantasyPoints(stats: any, settings: Record<string, number>): number {
    if (stats.did_not_play) return 0
    return parseFloat(
        (
            (stats.points ?? 0)                * (settings.points                  ?? 0) +
            (stats.rebounds ?? 0)              * (settings.rebounds                ?? 0) +
            (stats.assists ?? 0)               * (settings.assists                 ?? 0) +
            (stats.steals ?? 0)                * (settings.steals                  ?? 0) +
            (stats.blocks ?? 0)                * (settings.blocks                  ?? 0) +
            (stats.turnovers ?? 0)             * (settings.turnovers               ?? 0) +
            (stats.three_pointers_made ?? 0)   * (settings.three_pointers_made     ?? 0) +
            (stats.field_goals_made ?? 0)      * (settings.field_goals_made        ?? 0) +
            (stats.field_goals_attempted ?? 0) * (settings.field_goals_attempted   ?? 0) +
            (stats.free_throws_made ?? 0)      * (settings.free_throws_made        ?? 0) +
            (stats.free_throws_attempted ?? 0) * (settings.free_throws_attempted   ?? 0) +
            (stats.double_double === true ? (settings.double_double ?? 0) : 0) +
            (stats.triple_double === true ? (settings.triple_double ?? 0) : 0)
        ).toFixed(2),
    )
}

// Returns the current/most-recent week number for a given NBA season year.
// Looks for the latest game_date <= today.
export async function getWeekNumberForDate(date: Date, seasonYear: number): Promise<number | null> {
    const dateISO = date.toISOString().split('T')[0]
    const { data } = await supabase
        .from('nba_games')
        .select('week_number')
        .eq('season_year', seasonYear)
        .lte('game_date', dateISO)
        .order('game_date', { ascending: false })
        .limit(1)
        .maybeSingle()
    return data?.week_number ?? null
}

import { supabase } from '@/lib/supabase'
import { todayET } from '@/lib/shared/dates'
import { calculateWeekNumberFromDate, resolveSeasonWeekNumber, type SeasonWeekRange } from '@pancake/core'

export { calculateWeekNumberFromDate }

/**
 * Returns the week number for a given NBA season year.
 * Finds the seeded week containing today, the next future week, or the final
 * seeded week after the season ends.
 */
export async function getCurrentWeekNumber(seasonYear: number): Promise<number | null> {
    // season_weeks.week_start / week_end are ET-aligned (backend uses toETDate);
    // use todayET so non-ET clients don't fall into the wrong fantasy week
    // during the 0–3h local-vs-ET skew.
    const today = todayET()

    const { data, error } = await supabase
        .from('season_weeks')
        .select('week_number, week_start, week_end')
        .eq('season_year', seasonYear)
        .order('week_number', { ascending: true })
    if (error) throw error

    return resolveSeasonWeekNumber((data ?? []) as SeasonWeekRange[], today, 'current-or-next')
}

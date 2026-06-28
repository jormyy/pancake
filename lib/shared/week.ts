import { supabase } from '@/lib/supabase'
import { todayET } from '@/lib/shared/dates'
import { calculateWeekNumberFromDate } from '@pancake/core'

export { calculateWeekNumberFromDate }

/**
 * Fetches the start/end dates for week 1 of a given season year.
 */
async function getWeek1Bounds(seasonYear: number): Promise<{ weekStart: string; weekEnd: string } | null> {
    const { data, error } = await supabase
        .from('season_weeks')
        .select('week_start, week_end')
        .eq('season_year', seasonYear)
        .eq('week_number', 1)
        .maybeSingle()
    if (error) throw error

    return data ? { weekStart: data.week_start, weekEnd: data.week_end } : null
}

/**
 * Returns the week number for a given NBA season year.
 * Finds the week in season_weeks that contains today, or the next week.
 * Falls back to date-based calculation using week 1 boundaries from the database.
 * Returns null if no data is available and the season hasn't been seeded yet.
 */
export async function getCurrentWeekNumber(seasonYear: number): Promise<number | null> {
    // season_weeks.week_start / week_end are ET-aligned (backend uses toETDate);
    // use todayET so non-ET clients don't fall into the wrong fantasy week
    // during the 0–3h local-vs-ET skew.
    const today = todayET()

    // Try to find a week that contains today
    const { data: todayWeek, error: todayErr } = await supabase
        .from('season_weeks')
        .select('week_number, week_start, week_end')
        .eq('season_year', seasonYear)
        .lte('week_start', today)
        .gte('week_end', today)
        .maybeSingle()
    if (todayErr) throw todayErr

    if (todayWeek) {
        return todayWeek.week_number
    }

    // Find week with week_end >= today (current or future week)
    const { data: futureWeek, error: futureErr } = await supabase
        .from('season_weeks')
        .select('week_number, week_start, week_end')
        .eq('season_year', seasonYear)
        .gte('week_end', today)
        .order('week_start', { ascending: true })
        .limit(1)
        .maybeSingle()
    if (futureErr) throw futureErr

    if (futureWeek) {
        return futureWeek.week_number
    }

    // After the final seeded fantasy week, do not keep extrapolating fake
    // offseason week numbers. Keep reads anchored to the last known week.
    const { data: lastWeek, error: lastErr } = await supabase
        .from('season_weeks')
        .select('week_number, week_end')
        .eq('season_year', seasonYear)
        .order('week_number', { ascending: false })
        .limit(1)
        .maybeSingle()
    if (lastErr) throw lastErr

    if (lastWeek && today > lastWeek.week_end) {
        return lastWeek.week_number
    }

    // Fallback: calculate from date using week 1 boundaries
    const week1 = await getWeek1Bounds(seasonYear)
    if (!week1) return null

    return calculateWeekNumberFromDate(today, week1.weekStart, week1.weekEnd)
}

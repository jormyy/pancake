import { supabase } from '@/lib/supabase'
import { todayDateString } from '@/lib/shared/dates'

/**
 * Calculates week number from a date given explicit season week boundaries.
 * Week 1 is typically 6 days (Tue-Sun). Week 2+ are 7-day weeks (Mon-Sun).
 */
export function calculateWeekNumberFromDate(
    dateStr: string,
    week1StartStr: string,
    week1EndStr: string,
): number {
    const date = new Date(dateStr + 'T00:00:00')
    const week1Start = new Date(week1StartStr + 'T00:00:00')
    const week1End = new Date(week1EndStr + 'T23:59:59')

    if (date >= week1Start && date <= week1End) {
        return 1
    }

    // Week 2 starts the day after week 1 ends (midnight)
    const week2Start = new Date(week1EndStr + 'T00:00:00')
    week2Start.setDate(week2Start.getDate() + 1)
    const msPerWeek = 7 * 24 * 60 * 60 * 1000
    const weeksSinceWeek2 = Math.floor((date.getTime() - week2Start.getTime()) / msPerWeek)
    const weekNumber = weeksSinceWeek2 + 2

    return Math.max(1, weekNumber)
}

/**
 * Fetches the start/end dates for week 1 of a given season year.
 */
async function getWeek1Bounds(seasonYear: number): Promise<{ weekStart: string; weekEnd: string } | null> {
    const { data } = await supabase
        .from('season_weeks')
        .select('week_start, week_end')
        .eq('season_year', seasonYear)
        .eq('week_number', 1)
        .maybeSingle()

    return data ? { weekStart: data.week_start, weekEnd: data.week_end } : null
}

/**
 * Returns the week number for a given NBA season year.
 * Finds the week in season_weeks that contains today, or the next week.
 * Falls back to date-based calculation using week 1 boundaries from the database.
 * Returns null if no data is available and the season hasn't been seeded yet.
 */
export async function getCurrentWeekNumber(seasonYear: number): Promise<number | null> {
    const today = todayDateString()

    // Try to find a week that contains today
    const { data: todayWeek } = await supabase
        .from('season_weeks')
        .select('week_number, week_start, week_end')
        .eq('season_year', seasonYear)
        .lte('week_start', today)
        .gte('week_end', today)
        .maybeSingle()

    if (todayWeek) {
        return todayWeek.week_number
    }

    // Find week with week_end >= today (current or future week)
    const { data: futureWeek } = await supabase
        .from('season_weeks')
        .select('week_number, week_start, week_end')
        .eq('season_year', seasonYear)
        .gte('week_end', today)
        .order('week_start', { ascending: true })
        .limit(1)
        .maybeSingle()

    if (futureWeek) {
        return futureWeek.week_number
    }

    // Fallback: calculate from date using week 1 boundaries
    const week1 = await getWeek1Bounds(seasonYear)
    if (!week1) return null

    return calculateWeekNumberFromDate(today, week1.weekStart, week1.weekEnd)
}

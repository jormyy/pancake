import { supabase } from '@/lib/supabase'
import { todayDateString } from '@/lib/shared/dates'

/**
 * Calculates week number directly from date without database lookups.
 * Matches NBA schedule's week numbering:
 * - Week 1: Oct 21-26, 2025 (6 days, first regular season games)
 * - Week 2+: 7-day weeks starting Oct 27, 2025
 */
export function calculateWeekNumberFromDate(dateStr: string): number {
    const date = new Date(dateStr + 'T00:00:00')

    // Week 1 is Oct 21-26, 2025
    const week1Start = new Date('2025-10-21T00:00:00')
    const week1End = new Date('2025-10-26T23:59:59')

    if (date >= week1Start && date <= week1End) {
        console.log(`[week] calculateWeekNumberFromDate: ${dateStr} -> Week 1 (Week 1 special case)`)
        return 1
    }

    // For Week 2+, calculate from Oct 27, 2025 (start of Week 2)
    const week2Start = new Date('2025-10-27T00:00:00')
    const msPerWeek = 7 * 24 * 60 * 60 * 1000
    const weeksSinceWeek2 = Math.floor((date.getTime() - week2Start.getTime()) / msPerWeek)

    // Week 2 is 0 weeks after week2Start, so add 2 to get correct week number
    const weekNumber = weeksSinceWeek2 + 2

    console.log(`[week] calculateWeekNumberFromDate: ${dateStr} -> Week ${weekNumber}`)
    return Math.max(1, weekNumber)
}

/**
 * Returns the week number for a given NBA season year.
 * Finds the week in season_weeks that contains today, or the next week.
 * Falls back to date-based calculation.
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
        console.log(`[week] Found week containing today: week ${todayWeek.week_number} (${todayWeek.week_start} - ${todayWeek.week_end})`)
        return todayWeek.week_number
    }

    // No week contains today - might be between weeks or week_end is wrong
    console.log(`[week] No week contains ${today}, finding nearest week`)

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
        console.log(`[week] Found future week: week ${futureWeek.week_number} (${futureWeek.week_start} - ${futureWeek.week_end})`)
        return futureWeek.week_number
    }

    // Fallback to date-based calculation
    const calculatedWeek = calculateWeekNumberFromDate(today)
    console.log(`[week] Using calculated week: ${calculatedWeek}`)
    return calculatedWeek
}

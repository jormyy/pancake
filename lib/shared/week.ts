import { supabase } from '@/lib/supabase'
import { todayET } from '@/lib/shared/dates'
import { onSessionCachesCleared } from '@/lib/session-cache-registry'
import { calculateWeekNumberFromDate, resolveSeasonWeekNumber, type SeasonWeekRange } from '@pancake/core'

export { calculateWeekNumberFromDate }

// Seeded week ranges are static for a season, and the current week only
// changes when the ET day changes — memoize the season's weeks per
// (seasonYear, ET day) so screen loads don't refetch season_weeks.
const seasonWeeksCache = new Map<string, Promise<SeasonWeekRange[]>>()

/** Drops memoized week lookups (tests / commissioner schedule edits). */
export function invalidateWeekNumberCache() {
    seasonWeeksCache.clear()
}

onSessionCachesCleared(invalidateWeekNumberCache)

function getSeasonWeeks(seasonYear: number, today: string): Promise<SeasonWeekRange[]> {
    const cacheKey = `${seasonYear}:${today}`
    const hit = seasonWeeksCache.get(cacheKey)
    if (hit) return hit

    const promise = (async () => {
        const { data, error } = await supabase
            .from('season_weeks')
            .select('week_number, week_start, week_end')
            .eq('season_year', seasonYear)
            .order('week_number', { ascending: true })
        if (error) throw error
        return (data ?? []) as SeasonWeekRange[]
    })()
    seasonWeeksCache.set(cacheKey, promise)
    promise.catch(() => {
        if (seasonWeeksCache.get(cacheKey) === promise) seasonWeeksCache.delete(cacheKey)
    })
    return promise
}

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
    return resolveSeasonWeekNumber(await getSeasonWeeks(seasonYear, today), today, 'current-or-next')
}

export async function getSeasonWeekDates(seasonYear: number, weekNumber: number): Promise<string[]> {
    const weeks = await getSeasonWeeks(seasonYear, todayET())
    const week = weeks.find((row) => row.week_number === weekNumber)
    if (!week) return []
    let start = Date.parse(`${week.week_start}T12:00:00Z`)
    if (weekNumber === 1) start -= (new Date(start).getUTCDay() + 6) % 7 * 86_400_000
    const end = Date.parse(`${week.week_end}T12:00:00Z`)
    return Array.from({ length: Math.floor((end - start) / 86_400_000) + 1 }, (_, index) =>
        new Date(start + index * 86_400_000).toISOString().slice(0, 10))
}

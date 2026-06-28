import { supabase } from './supabase'
import { toETDate } from './utils/date'
export { calculateFantasyPoints, roundFantasyPoints, snakeToStatLine } from '@pancake/core'
export type { ScoringSettings, StatLine } from '@pancake/core'

// Returns the week number that contains the given date, using season_weeks as the
// source of truth (more reliable than nba_games.week_number which can drift).
// If today falls between weeks (e.g. Monday before first game of new week),
// returns the most recently started week so the caller can finalize it.
export async function getWeekNumberForDate(date: Date, seasonYear: number): Promise<number | null> {
    const dateISO = toETDate(date)

    // Exact match: today falls within a known week's game-date range
    const { data: exact, error: exactErr } = await supabase
        .from('season_weeks')
        .select('week_number')
        .eq('season_year', seasonYear)
        .lte('week_start', dateISO)
        .gte('week_end', dateISO)
        .maybeSingle()
    if (exactErr) throw exactErr
    if (exact) return exact.week_number

    // Today is between weeks (gap day) — return the most recently started week
    const { data: last, error: lastErr } = await supabase
        .from('season_weeks')
        .select('week_number, week_end, season_year')
        .eq('season_year', seasonYear)
        .lte('week_start', dateISO)
        .order('week_start', { ascending: false })
        .limit(1)
        .maybeSingle()
    if (lastErr) throw lastErr

    if (!last) return null

    // If today is after the last seeded week, keep syncing/finalizing the
    // final real week instead of inventing an unseeded week number.
    if (dateISO > last.week_end) {
        return last.week_number
    }

    return last.week_number
}

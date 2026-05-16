import { supabase } from './supabase'
import { calculateFantasyPoints, snakeToStatLine } from '@pancake/core'
import type { StatLine, ScoringSettings } from '@pancake/core'

// Pure scoring helpers live in @pancake/core; re-export so existing callers
// (and backend tests) can keep importing from this module.
export { calculateFantasyPoints, snakeToStatLine }
export type { StatLine, ScoringSettings }

// Returns the week number that contains the given date, using season_weeks as the
// source of truth (more reliable than nba_games.week_number which can drift).
// If today falls between weeks (e.g. Monday before first game of new week),
// returns the most recently started week so the caller can finalize it.
export async function getWeekNumberForDate(date: Date, seasonYear: number): Promise<number | null> {
    const dateISO = date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

    // Exact match: today falls within a known week's game-date range
    const { data: exact } = await supabase
        .from('season_weeks')
        .select('week_number')
        .eq('season_year', seasonYear)
        .lte('week_start', dateISO)
        .gte('week_end', dateISO)
        .maybeSingle()
    if (exact) return exact.week_number

    // Try without season_year filter in case of data mismatch
    const { data: anySeason } = await supabase
        .from('season_weeks')
        .select('week_number, season_year')
        .lte('week_start', dateISO)
        .gte('week_end', dateISO)
        .maybeSingle()
    if (anySeason) return anySeason.week_number

    // Today is between weeks (gap day) — return the most recently started week
    const { data: last } = await supabase
        .from('season_weeks')
        .select('week_number, week_end, season_year')
        .lte('week_start', dateISO)
        .order('week_start', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (!last) return null

    // If today is after the last week's end, move to next week
    if (dateISO > last.week_end) {
        return last.week_number + 1
    }

    return last.week_number
}

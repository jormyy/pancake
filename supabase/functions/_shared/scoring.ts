import { supabase } from './supabase.ts'
import { resolveSeasonWeekNumber, type SeasonWeekRange } from './weekPolicy.ts'
export { calculateFantasyPoints, roundFantasyPoints, snakeToStatLine } from './scoringCore.ts'

export async function getWeekNumberForDate(date: Date, seasonYear: number): Promise<number | null> {
    const dateISO = date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

    const { data, error } = await supabase
        .from('season_weeks')
        .select('week_number, week_start, week_end')
        .eq('season_year', seasonYear)
        .order('week_number', { ascending: true })
    if (error) throw error

    return resolveSeasonWeekNumber((data ?? []) as SeasonWeekRange[], dateISO, 'current-or-previous')
}

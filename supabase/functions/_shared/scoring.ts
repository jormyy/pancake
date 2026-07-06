import { supabase } from './supabase.ts'
export { calculateFantasyPoints, roundFantasyPoints, snakeToStatLine } from './scoringCore.ts'

export async function getWeekNumberForDate(date: Date, seasonYear: number): Promise<number | null> {
    const dateISO = date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

    const { data: exact, error: exactErr } = await supabase
        .from('season_weeks')
        .select('week_number')
        .eq('season_year', seasonYear)
        .lte('week_start', dateISO)
        .gte('week_end', dateISO)
        .maybeSingle()
    if (exactErr) throw exactErr
    if (exact) return exact.week_number

    const { data: last, error: lastErr } = await supabase
        .from('season_weeks')
        .select('week_number, week_end')
        .eq('season_year', seasonYear)
        .lte('week_start', dateISO)
        .order('week_start', { ascending: false })
        .limit(1)
        .maybeSingle()
    if (lastErr) throw lastErr

    if (!last) return null
    if (dateISO > last.week_end) return last.week_number
    return last.week_number
}

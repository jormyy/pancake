import { supabase } from './supabase.ts'

// Edge functions cannot reliably import the workspace package during Supabase
// deployment. Keep this pure helper in sync with core/src/scoring/*.
export type ScoringSettings = Record<string, number>

export interface StatLine {
    points: number
    rebounds: number
    assists: number
    steals: number
    blocks: number
    turnovers: number
    threePointersMade: number
    fieldGoalsMade: number
    fieldGoalsAttempted: number
    freeThrowsMade: number
    freeThrowsAttempted: number
    doubleDouble: boolean
    tripleDouble: boolean
    didNotPlay: boolean
}

export function calculateFantasyPoints(
    stats: StatLine,
    settings: ScoringSettings,
): number {
    if (stats.didNotPlay) return 0
    return parseFloat(
        (
            stats.points * (settings.points ?? 0) +
            stats.rebounds * (settings.rebounds ?? 0) +
            stats.assists * (settings.assists ?? 0) +
            stats.steals * (settings.steals ?? 0) +
            stats.blocks * (settings.blocks ?? 0) +
            stats.turnovers * (settings.turnovers ?? 0) +
            stats.threePointersMade * (settings.three_pointers_made ?? 0) +
            stats.fieldGoalsMade * (settings.field_goals_made ?? 0) +
            stats.fieldGoalsAttempted * (settings.field_goals_attempted ?? 0) +
            stats.freeThrowsMade * (settings.free_throws_made ?? 0) +
            stats.freeThrowsAttempted * (settings.free_throws_attempted ?? 0) +
            (stats.doubleDouble ? (settings.double_double ?? 0) : 0) +
            (stats.tripleDouble ? (settings.triple_double ?? 0) : 0)
        ).toFixed(2),
    )
}

export function snakeToStatLine(row: Record<string, unknown>): StatLine {
    return {
        points: (row.points as number) ?? 0,
        rebounds: (row.rebounds as number) ?? 0,
        assists: (row.assists as number) ?? 0,
        steals: (row.steals as number) ?? 0,
        blocks: (row.blocks as number) ?? 0,
        turnovers: (row.turnovers as number) ?? 0,
        threePointersMade: (row.three_pointers_made as number) ?? 0,
        fieldGoalsMade: (row.field_goals_made as number) ?? 0,
        fieldGoalsAttempted: (row.field_goals_attempted as number) ?? 0,
        freeThrowsMade: (row.free_throws_made as number) ?? 0,
        freeThrowsAttempted: (row.free_throws_attempted as number) ?? 0,
        doubleDouble: (row.double_double as boolean) ?? false,
        tripleDouble: (row.triple_double as boolean) ?? false,
        didNotPlay: (row.did_not_play as boolean) ?? false,
    }
}

export async function getWeekNumberForDate(date: Date, seasonYear: number): Promise<number | null> {
    const dateISO = date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

    const { data: exact } = await supabase
        .from('season_weeks')
        .select('week_number')
        .eq('season_year', seasonYear)
        .lte('week_start', dateISO)
        .gte('week_end', dateISO)
        .maybeSingle()
    if (exact) return exact.week_number

    const { data: last } = await supabase
        .from('season_weeks')
        .select('week_number, week_end')
        .eq('season_year', seasonYear)
        .lte('week_start', dateISO)
        .order('week_start', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (!last) return null
    if (dateISO > last.week_end) return last.week_number + 1
    return last.week_number
}

export async function getWeekBounds(seasonYear: number, weekNumber: number): Promise<{ weekStart: string; weekEnd: string } | null> {
    const { data } = await supabase
        .from('season_weeks')
        .select('week_start, week_end')
        .eq('season_year', seasonYear)
        .eq('week_number', weekNumber)
        .maybeSingle()

    return data ? { weekStart: data.week_start, weekEnd: data.week_end } : null
}

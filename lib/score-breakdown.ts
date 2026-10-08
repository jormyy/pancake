import { roundFantasyPoints } from '@pancake/core'
import type { LiveStatLine } from '@/lib/games'

type ScoredStat = {
    key: string
    label: string
    count: (stats: LiveStatLine) => number
}

// Same stats and setting keys as calculateFantasyPoints in @pancake/core.
const SCORED_STATS: ScoredStat[] = [
    { key: 'points', label: 'Points', count: (s) => s.points },
    { key: 'rebounds', label: 'Rebounds', count: (s) => s.rebounds },
    { key: 'assists', label: 'Assists', count: (s) => s.assists },
    { key: 'steals', label: 'Steals', count: (s) => s.steals },
    { key: 'blocks', label: 'Blocks', count: (s) => s.blocks },
    { key: 'three_pointers_made', label: '3-pointers', count: (s) => s.threeMade },
    { key: 'turnovers', label: 'Turnovers', count: (s) => s.turnovers ?? 0 },
    { key: 'field_goals_made', label: 'Field goals made', count: (s) => s.fgMade },
    { key: 'field_goals_attempted', label: 'Field goals tried', count: (s) => s.fgAttempted },
    { key: 'free_throws_made', label: 'Free throws made', count: (s) => s.ftMade },
    { key: 'free_throws_attempted', label: 'Free throws tried', count: (s) => s.ftAttempted },
    { key: 'double_double', label: 'Double-double', count: (s) => (s.doubleDouble ? 1 : 0) },
    { key: 'triple_double', label: 'Triple-double', count: (s) => (s.tripleDouble ? 1 : 0) },
]

export type BreakdownRow = {
    key: string
    label: string
    weight: number
    count: number | null
    points: number | null
}

/** The league's scored stats, each with what this stat line earned. */
export function scoreBreakdown(stats: LiveStatLine | undefined, settings: Record<string, number>): BreakdownRow[] {
    const played = stats != null && !stats.didNotPlay
    return SCORED_STATS
        .filter((stat) => (settings[stat.key] ?? 0) !== 0)
        .map((stat) => {
            const weight = settings[stat.key]
            const count = played ? stat.count(stats) : null
            return {
                key: stat.key,
                label: stat.label,
                weight,
                count,
                points: count == null ? null : roundFantasyPoints(count * weight),
            }
        })
}

export type StatColumn = {
    key: string
    label: string
    wide?: boolean
    value: (stats: LiveStatLine) => string
}

const COUNT_COLUMNS: (StatColumn & { settings: string[] })[] = [
    { key: 'pts', label: 'PTS', settings: ['points'], value: (s) => String(s.points) },
    { key: 'reb', label: 'REB', settings: ['rebounds'], value: (s) => String(s.rebounds) },
    { key: 'ast', label: 'AST', settings: ['assists'], value: (s) => String(s.assists) },
    { key: 'stl', label: 'STL', settings: ['steals'], value: (s) => String(s.steals) },
    { key: 'blk', label: 'BLK', settings: ['blocks'], value: (s) => String(s.blocks) },
    { key: '3pm', label: '3PM', settings: ['three_pointers_made'], value: (s) => String(s.threeMade) },
    { key: 'to', label: 'TO', settings: ['turnovers'], value: (s) => String(s.turnovers ?? 0) },
    { key: 'fg', label: 'FG', wide: true, settings: ['field_goals_made', 'field_goals_attempted'], value: (s) => `${s.fgMade}/${s.fgAttempted}` },
    { key: 'ft', label: 'FT', wide: true, settings: ['free_throws_made', 'free_throws_attempted'], value: (s) => `${s.ftMade}/${s.ftAttempted}` },
]

/**
 * Box-score columns for wide lineups: only the stats this league scores, with
 * made/attempted pairs folded into one column. Falls back to the counting
 * stats when the league has no scoring settings loaded.
 */
export function lineupStatColumns(settings: Record<string, number>): StatColumn[] {
    const scored = COUNT_COLUMNS.filter((column) => column.settings.some((key) => (settings[key] ?? 0) !== 0))
    const columns = scored.length > 0 ? scored : COUNT_COLUMNS.filter((column) => !column.wide)
    return columns.map(({ key, label, wide, value }) => ({ key, label, wide, value }))
}

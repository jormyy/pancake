import { StatLine, ScoringSettings } from './types'

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

/**
 * Convert a snake_case stat row (as stored in the DB) into a camelCase StatLine.
 * Missing or null fields default to 0 / false so callers don't need to guard.
 */
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

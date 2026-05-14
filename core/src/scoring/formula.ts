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

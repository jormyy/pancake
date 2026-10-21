export type DraftTimerOption = number
export type RookieRoundOption = 2 | 3
export const DRAFT_TIMER_MIN_SECONDS = 5
export const DRAFT_TIMER_MAX_SECONDS = 3600
export const ROOKIE_TIMER_MIN_SECONDS = 60
export const ROOKIE_TIMER_MAX_SECONDS = 604800

export function normalizeDraftTimerSeconds(value: number): DraftTimerOption {
    if (!Number.isInteger(value) || value < DRAFT_TIMER_MIN_SECONDS || value > ROOKIE_TIMER_MAX_SECONDS) {
        throw new Error('Draft timer must be a whole number of seconds within the allowed range.')
    }
    return value
}

export function validateRookieTimerSeconds(value: number): number {
    if (!Number.isInteger(value) || value < ROOKIE_TIMER_MIN_SECONDS || value > ROOKIE_TIMER_MAX_SECONDS) {
        throw new Error('Rookie pick timer must be between 1 minute and 7 days (60–604800 seconds).')
    }
    return value
}

export function formatDraftDuration(seconds: number): string {
    if (seconds % 86400 === 0) return `${seconds / 86400}d`
    if (seconds % 3600 === 0) return `${seconds / 3600}h`
    if (seconds % 60 === 0) return `${seconds / 60}m`
    return `${seconds}s`
}

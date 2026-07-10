export type DraftTimerOption = number
export type RookieRoundOption = 2 | 3
export const DRAFT_TIMER_MIN_SECONDS = 5
export const DRAFT_TIMER_MAX_SECONDS = 3600

export function normalizeDraftTimerSeconds(value: number): DraftTimerOption {
    if (!Number.isFinite(value)) return 30
    return Math.min(DRAFT_TIMER_MAX_SECONDS, Math.max(DRAFT_TIMER_MIN_SECONDS, Math.floor(value)))
}

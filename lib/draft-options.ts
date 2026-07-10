const ROOKIE_ROUND_OPTIONS = [2, 3] as const

export type DraftTimerOption = number
export type RookieRoundOption = (typeof ROOKIE_ROUND_OPTIONS)[number]
export const DRAFT_TIMER_MIN_SECONDS = 5
export const DRAFT_TIMER_MAX_SECONDS = 3600

export function normalizeDraftTimerSeconds(value: number): DraftTimerOption {
    if (!Number.isFinite(value)) return 30
    return Math.min(DRAFT_TIMER_MAX_SECONDS, Math.max(DRAFT_TIMER_MIN_SECONDS, Math.floor(value)))
}

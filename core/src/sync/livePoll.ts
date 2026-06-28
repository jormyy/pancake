import { toETDate } from '../dates'

export const LIVE_POLL_LOCK_KEY = 779001
export const LIVE_POLL_LEASE_TTL_SECONDS = 90

export function addDaysToETDate(dateKey: string, days: number): string {
    const [year, month, day] = dateKey.split('-').map(Number)
    const shifted = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0))
    return shifted.toISOString().slice(0, 10)
}

export function dateFromETDate(dateKey: string): Date {
    return new Date(`${dateKey}T12:00:00Z`)
}

export function livePollCandidateDates(now = new Date()): string[] {
    const today = toETDate(now)
    return [...new Set([addDaysToETDate(today, -1), today])]
}

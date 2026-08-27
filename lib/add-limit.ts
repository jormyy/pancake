import type { MemberTransactionState } from '@/lib/league'

export type AddLimitStatus = {
    limit: number
    used: number
    remaining: number
    reached: boolean
    resetsAt: Date | null
    timeZone: string
}

type AddLimitSource = Pick<MemberTransactionState, 'weeklyAddLimit' | 'weeklyAddCount' | 'addLimitResetsAt' | 'addWeekTimeZone'>

export const ADD_LIMIT_BLOCKED_TITLE = 'Weekly add limit reached'

const ZONE_LABELS: Record<string, string> = { 'America/New_York': 'ET' }

export function isAddLimitError(message: string | null | undefined): boolean {
    return /weekly add limit reached/i.test(message ?? '')
}

export function getAddLimitStatus(state: AddLimitSource | null | undefined, now = Date.now()): AddLimitStatus | null {
    if (!state || state.weeklyAddLimit == null) return null
    const parsed = state.addLimitResetsAt ? new Date(state.addLimitResetsAt) : null
    const resetsAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null
    // A count whose week already ended is stale client state; the server opens a
    // fresh week on the next request, so the action is available again.
    const weekEnded = resetsAt != null && resetsAt.getTime() <= now
    const used = weekEnded ? 0 : state.weeklyAddCount
    return {
        limit: state.weeklyAddLimit,
        used,
        remaining: Math.max(0, state.weeklyAddLimit - used),
        reached: !weekEnded && state.weeklyAddCount >= state.weeklyAddLimit,
        resetsAt: weekEnded ? null : resetsAt,
        timeZone: state.addWeekTimeZone || 'America/New_York',
    }
}

function deviceTimeZone(): string | null {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null
    } catch {
        return null
    }
}

function zoneLabel(timeZone: string, date: Date): string {
    if (ZONE_LABELS[timeZone]) return ZONE_LABELS[timeZone]
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
        .formatToParts(date)
        .find((item) => item.type === 'timeZoneName')
    return part?.value ?? timeZone
}

function formatInZone(date: Date, timeZone: string, style: 'long' | 'short'): string {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    }).formatToParts(date)
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
    const time = `${get('hour')}:${get('minute')} ${get('dayPeriod')}`.trim()
    if (style === 'short') return `${get('weekday')} ${time} ${zoneLabel(timeZone, date)}`
    return `${get('weekday')}, ${get('month')} ${get('day')} at ${time} ${zoneLabel(timeZone, date)}`
}

/**
 * "Mon, Nov 3 at 12:00 AM ET (Sun, Nov 2 at 9:00 PM PST)" — the league's
 * reset boundary first, the viewer's local time in parentheses when it differs.
 */
export function formatAddLimitReset(
    status: Pick<AddLimitStatus, 'resetsAt' | 'timeZone'>,
    options: { style?: 'long' | 'short'; localTimeZone?: string | null } = {},
): string | null {
    if (!status.resetsAt) return null
    const style = options.style ?? 'long'
    const league = formatInZone(status.resetsAt, status.timeZone, style)
    if (style === 'short') return league
    const local = options.localTimeZone === undefined ? deviceTimeZone() : options.localTimeZone
    if (!local || local === status.timeZone) return league
    try {
        return `${league} (${formatInZone(status.resetsAt, local, 'long')})`
    } catch {
        return league
    }
}

export function addLimitBlockedMessage(status: AddLimitStatus, options?: { localTimeZone?: string | null }): string {
    const reset = formatAddLimitReset(status, { style: 'long', localTimeZone: options?.localTimeZone })
    const opening = `You've used all ${status.limit} of this week's adds.`
    return reset ? `${opening} Adds reset ${reset}.` : `${opening} Adds reset when the next week starts.`
}

/** Compact status for headers: "Adds 7/7 · resets Mon 12:00 AM ET". */
export function addLimitSummary(status: AddLimitStatus): string {
    const base = `Adds ${status.used}/${status.limit}`
    if (!status.reached) return base
    const reset = formatAddLimitReset(status, { style: 'short' })
    return reset ? `${base} · resets ${reset}` : `${base} · limit reached`
}

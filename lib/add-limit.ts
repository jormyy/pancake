import type { MemberTransactionState } from '@/lib/league'
import { RULE_CODES, errorCode, getErrorMessage } from '@/lib/shared/errors'

export type AddLimitSource = Pick<MemberTransactionState, 'weeklyAddLimit' | 'weeklyAddCount' | 'addLimitResetsAt' | 'addWeekTimeZone'>

export type AddLimitStatus = {
    limit: number
    used: number
    reached: boolean
    resetsAt: Date | null
    timeZone: string
}

export type PickupError = {
    limitReached: boolean
    /** The player is still on waivers (possibly past the 48-hour mark, until the run processes the entry); a claim is the way in. */
    onWaivers: boolean
    title: string
    message: string
}

export const ADD_LIMIT_BLOCKED_TITLE = 'Weekly add limit reached'
const ON_WAIVERS_TITLE = 'Still on waivers'

const ZONE_LABELS: Record<string, string> = { 'America/New_York': 'ET' }

export function getAddLimitStatus(state: AddLimitSource | null | undefined, now = Date.now()): AddLimitStatus | null {
    if (!state || state.weeklyAddLimit == null) return null
    const parsed = state.addLimitResetsAt ? new Date(state.addLimitResetsAt) : null
    const resetsAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null
    // A count whose week already ended is stale client state; the server opens a
    // fresh week on the next request, so the action is available again.
    const weekEnded = resetsAt != null && resetsAt.getTime() <= now
    return {
        limit: state.weeklyAddLimit,
        used: weekEnded ? 0 : state.weeklyAddCount,
        reached: !weekEnded && state.weeklyAddCount >= state.weeklyAddLimit,
        resetsAt: weekEnded ? null : resetsAt,
        timeZone: state.addWeekTimeZone,
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
    options: { style?: 'long' | 'short'; localTimeZone?: string } = {},
): string | null {
    if (!status.resetsAt) return null
    const style = options.style ?? 'long'
    const league = formatInZone(status.resetsAt, status.timeZone, style)
    if (style === 'short') return league
    const local = options.localTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    if (!local || local === status.timeZone) return league
    return `${league} (${formatInZone(status.resetsAt, local, 'long')})`
}

export function addLimitBlockedMessage(status: AddLimitStatus, options?: { localTimeZone?: string }): string {
    const reset = formatAddLimitReset(status, { style: 'long', localTimeZone: options?.localTimeZone })
    const opening = `You've used all ${status.limit} of this week's adds.`
    return reset ? `${opening} Adds reset ${reset}.` : `${opening} Adds reset when the next week starts.`
}

/** The explanation to show when a pickup is blocked by the weekly add limit, or null when adds are available. */
export function addLimitBlockedReason(state: AddLimitSource | null | undefined, now = Date.now()): string | null {
    const status = getAddLimitStatus(state, now)
    return status?.reached ? addLimitBlockedMessage(status) : null
}

/** Compact header status: "Adds 7/7 · resets Mon 12:00 AM ET", "Adds 2/∞", or "Adds —/—" before state loads. */
export function addLimitSummary(state: AddLimitSource | null | undefined, now = Date.now()): string {
    if (!state) return 'Adds —/—'
    const status = getAddLimitStatus(state, now)
    if (!status) return `Adds ${state.weeklyAddCount}/∞`
    const base = `Adds ${status.used}/${status.limit}`
    if (!status.reached) return base
    const reset = formatAddLimitReset(status, { style: 'short' })
    return reset ? `${base} · resets ${reset}` : `${base} · limit reached`
}

/** Splits a failed pickup into the weekly-limit case (the server message carries the reset time), the on-waivers case, and everything else. */
export function classifyPickupError(error: unknown): PickupError {
    const message = getErrorMessage(error)
    const code = errorCode(error)
    const limitReached = code === RULE_CODES.weeklyAddLimit
    const onWaivers = code === RULE_CODES.onWaivers
    const title = limitReached ? ADD_LIMIT_BLOCKED_TITLE : onWaivers ? ON_WAIVERS_TITLE : 'Error'
    return { limitReached, onWaivers, title, message }
}

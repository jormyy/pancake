import type { MemberTransactionState } from '@/lib/league'
import { confirmAction, showAlert } from '@/lib/alert'
import { RULE_CODES, errorCode, getErrorMessage } from '@/lib/shared/errors'

export type AddLimitSource = Pick<MemberTransactionState, 'weeklyAddLimit' | 'weeklyAddCount' | 'addLimitResetsAt' | 'addLimitMessage' | 'addLimitResetsLabel'>

export type AddLimitStatus = {
    limit: number
    used: number
    /** The server's verdict: its rejection sentence is present exactly while the week's adds are used up. */
    reached: boolean
    message: string | null
    resetsLabel: string | null
}

export const ADD_LIMIT_BLOCKED_TITLE = 'Weekly add limit reached'
const ON_WAIVERS_TITLE = 'Still on waivers'

export function getAddLimitStatus(state: AddLimitSource | null | undefined, now = Date.now()): AddLimitStatus | null {
    if (!state || state.weeklyAddLimit == null) return null
    // A count whose week already ended is stale client state; the server opens a
    // fresh week on the next request, so the action is available again.
    const weekEnded = state.addLimitResetsAt != null && Date.parse(state.addLimitResetsAt) <= now
    if (weekEnded) return { limit: state.weeklyAddLimit, used: 0, reached: false, message: null, resetsLabel: null }
    return {
        limit: state.weeklyAddLimit,
        used: state.weeklyAddCount,
        reached: state.addLimitMessage != null,
        message: state.addLimitMessage,
        resetsLabel: state.addLimitResetsLabel,
    }
}

/** The server's explanation while a pickup is blocked by the weekly add limit, or null when adds are available. */
export function addLimitBlockedReason(state: AddLimitSource | null | undefined, now = Date.now()): string | null {
    return getAddLimitStatus(state, now)?.message ?? null
}

/** Compact header status: "Adds 7/7 · resets Mon, Nov 2 at 12:00 AM ET", "Adds 2/∞", or "Adds —/—" before state loads. */
export function addLimitSummary(state: AddLimitSource | null | undefined, now = Date.now()): string {
    if (!state) return 'Adds —/—'
    const status = getAddLimitStatus(state, now)
    if (!status) return `Adds ${state.weeklyAddCount}/∞`
    const base = `Adds ${status.used}/${status.limit}`
    if (!status.reached) return base
    return status.resetsLabel ? `${base} · resets ${status.resetsLabel}` : `${base} · limit reached`
}

export type PickupError = {
    limitReached: boolean
    /** The player is still on waivers (possibly past the 48-hour mark, until the run processes the entry); a claim is the way in. */
    onWaivers: boolean
    title: string
    message: string
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

type ReportOptions = {
    /** Reloads the weekly add state after a limit rejection. */
    refresh?: () => void
    /** Local cleanup once the server says the limit is reached (close a drop picker, etc.). */
    onLimitReached?: () => void
    /** Opens the claim flow when the server still holds the player on waivers. */
    claim?: () => void
}

/**
 * Explains a rejected pickup from the server's own verdict: the weekly limit
 * refreshes the cached state, a player still on waivers is offered the claim
 * flow, everything else is shown as it came.
 */
export function reportPickupError(error: unknown, { refresh, onLimitReached, claim }: ReportOptions = {}) {
    const failure = classifyPickupError(error)
    if (failure.limitReached) {
        onLimitReached?.()
        refresh?.()
    }
    if (failure.onWaivers && claim) {
        confirmAction(failure.title, `${failure.message} Claims are processed on the next waiver run.`, claim, 'Claim', false)
        return
    }
    showAlert(failure.title, failure.message)
}

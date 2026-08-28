import type { MemberTransactionState } from '@/lib/league'
import { confirmAction, showAlert } from '@/lib/alert'
import { RULE_CODES, errorCode, getErrorMessage } from '@/lib/shared/errors'

export type AddLimitSource = Pick<MemberTransactionState, 'weeklyAddLimit' | 'weeklyAddCount' | 'addLimitResetsAt' | 'addLimitMessage' | 'addLimitResetsLabel'>

type AddLimitStatus = {
    limit: number
    used: number
    /** The reported week already ended; the count belongs to it and the server opens a fresh week on the next request. */
    weekEnded: boolean
    /** The server's verdict: its rejection sentence, present exactly while the week's adds are used up. */
    message: string | null
    resetsLabel: string | null
}

export const ADD_LIMIT_BLOCKED_TITLE = 'Weekly add limit reached'
const ON_WAIVERS_TITLE = 'Still on waivers'

function getAddLimitStatus(state: AddLimitSource | null | undefined, now = Date.now()): AddLimitStatus | null {
    if (!state || state.weeklyAddLimit == null) return null
    const weekEnded = state.addLimitResetsAt != null && Date.parse(state.addLimitResetsAt) <= now
    return {
        limit: state.weeklyAddLimit,
        used: state.weeklyAddCount,
        weekEnded,
        message: weekEnded ? null : state.addLimitMessage,
        resetsLabel: weekEnded ? null : state.addLimitResetsLabel,
    }
}

/** The server's explanation while a pickup is blocked by the weekly add limit, or null when adds are available. */
export function addLimitBlockedReason(state: AddLimitSource | null | undefined, now = Date.now()): string | null {
    return getAddLimitStatus(state, now)?.message ?? null
}

/** Compact header status: "Adds 7/7 · resets Mon, Nov 2 at 12:00 AM ET", "Adds 7/7 · new week", "Adds 2/∞", or "Adds —/—" before state loads. */
export function addLimitSummary(state: AddLimitSource | null | undefined, now = Date.now()): string {
    if (!state) return 'Adds —/—'
    const status = getAddLimitStatus(state, now)
    if (!status) return `Adds ${state.weeklyAddCount}/∞`
    const base = `Adds ${status.used}/${status.limit}`
    if (status.weekEnded) return `${base} · new week`
    if (status.message == null) return base
    return status.resetsLabel ? `${base} · resets ${status.resetsLabel}` : `${base} · limit reached`
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
 * Explains a rejected pickup from the server's own verdict, classified on its
 * SQLSTATE: the weekly limit refreshes the cached state, a player still on
 * waivers (possibly past the 48-hour mark, until the run processes the entry)
 * is offered the claim flow, everything else is shown as it came.
 */
export function reportPickupError(error: unknown, { refresh, onLimitReached, claim }: ReportOptions = {}) {
    const code = errorCode(error)
    const message = getErrorMessage(error)
    if (code === RULE_CODES.weeklyAddLimit) {
        onLimitReached?.()
        refresh?.()
        showAlert(ADD_LIMIT_BLOCKED_TITLE, message)
        return
    }
    if (code === RULE_CODES.onWaivers && claim) {
        confirmAction(ON_WAIVERS_TITLE, `${message} Claims are processed on the next waiver run.`, claim, 'Claim', false)
        return
    }
    showAlert(code === RULE_CODES.onWaivers ? ON_WAIVERS_TITLE : 'Error', message)
}

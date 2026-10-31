import { formatLeagueDateTime } from '@/lib/timezone'
import { isIREligible, isTaxiEligible } from '@pancake/core'
import type { RosterOccupancy, RosterPlayer } from '@/lib/roster'
import type { MemberTransactionState } from '@/lib/league'
import { confirmAction, showAlert } from '@/lib/alert'
import { RULE_CODES, errorCode, getErrorMessage } from '@/lib/shared/errors'
import { getRosterProblems, type RosterProblem } from '@/lib/roster-problems'

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

/** Compact header status: "Adds 7/7 · new week", "Adds 2/∞", or "Adds —/—" before state loads. */
export function addLimitSummary(state: AddLimitSource | null | undefined, now = Date.now(), timezone?: string): string {
    if (!state) return 'Adds —/—'
    const status = getAddLimitStatus(state, now)
    if (!status) return `Adds ${state.weeklyAddCount}/∞`
    const base = `Adds ${status.used}/${status.limit}`
    if (status.weekEnded) return `${base} · new week`
    if (status.message == null) return base
    return state.addLimitResetsAt ? `${base} · resets ${formatLeagueDateTime(state.addLimitResetsAt, timezone)}` : `${base} · limit reached`
}

type ReportOptions = {
    /** Reloads ownership or the weekly add state after a server rejection. */
    refresh?: () => void
    /** Local cleanup once the server says the limit is reached (close a drop picker, etc.). */
    onLimitReached?: () => void
    /** Opens the claim flow when the server still holds the player on waivers. */
    claim?: () => void
    /** Opens the IR resolution flow when the server finds IR players who no longer qualify (a stale client); receives the sentence to show if nothing turns out to be ineligible. */
    onIneligibleIr?: (message: string) => void
}

/**
 * Explains a rejected pickup from the server's own verdict, classified on its
 * SQLSTATE: the weekly limit refreshes the cached state, a player still on
 * waivers (possibly past the 48-hour mark, until the run processes the entry)
 * is offered the claim flow, everything else is shown as it came.
 */
export function reportPickupError(error: unknown, { refresh, onLimitReached, claim, onIneligibleIr }: ReportOptions = {}) {
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
    if ((code === RULE_CODES.ineligibleIr || code === RULE_CODES.ineligibleTaxi) && onIneligibleIr) {
        onIneligibleIr(message)
        return
    }
    if (code === 'PA006' || code === 'PA007') {
        refresh?.()
        showAlert(code === 'PA006' ? 'Player cannot enter IR' : 'IR is full', message)
        return
    }
    if (code === '23505') refresh?.()
    showAlert(code === RULE_CODES.onWaivers ? ON_WAIVERS_TITLE : 'Error', message)
}

export function hasOpenIRSlot(roster: RosterOccupancy[], irSlots = 2): boolean {
    return roster.filter(player => player.is_on_ir).length < irSlots
}

export function canAddToIR(injuryStatus: string | null | undefined, roster: RosterOccupancy[], irSlots = 2): boolean {
    return isIREligible(injuryStatus ?? null) && hasOpenIRSlot(roster, irSlots)
}

export type PickupDestination = 'active' | 'taxi' | 'ir'

export function pickupDestinations(
    player: { id: string; injury_status?: string | null; years_exp?: number | null; career_regular_season_games?: number | null },
    roster: RosterPlayer[],
    limits: { rosterSize: number; taxiSlots: number; irSlots: number; allowIR: boolean },
    taxiExits: ReadonlySet<string>,
    drop?: RosterPlayer | null,
): Record<PickupDestination, boolean> {
    const remaining = roster.filter(row => row.id !== drop?.id)
    return {
        active: remaining.filter(row => !row.is_on_ir && !row.is_on_taxi).length < limits.rosterSize,
        taxi: remaining.filter(row => row.is_on_taxi).length < limits.taxiSlots
            && isTaxiEligible(player.years_exp ?? null, player.career_regular_season_games ?? null) && !taxiExits.has(player.id),
        ir: limits.allowIR && canAddToIR(player.injury_status, remaining, limits.irSlots),
    }
}

export function claimRosterProblems(roster: RosterPlayer[], rosterSize: number, drop?: RosterPlayer | null): RosterProblem[] {
    return getRosterProblems(roster, rosterSize).filter(problem => !problem.player || problem.player.id !== drop?.id)
}

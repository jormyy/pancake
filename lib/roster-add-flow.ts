import { isIneligibleIR } from '@/lib/format'
import {
    activateRosterPlayerWithOverflow,
    addFreeAgent,
    getPlayerRosterStatus,
    getRoster,
    toggleIR,
    type PlayerRosterStatus,
    type RosterPlayer,
} from '@/lib/roster'
import { getRosterStatusChangeLockMessage } from '@/lib/roster-locks'
import { RULE_CODES, errorCode } from '@/lib/shared/errors'
import { getMemberTransactionState, type MemberTransactionState } from '@/lib/league'

export async function loadRosterAddGate(
    memberId: string,
    leagueId: string,
    excludeRosterId?: string,
): Promise<{ roster: RosterPlayer[]; ineligible: RosterPlayer[] }> {
    const roster = await getRoster(memberId, leagueId)
    return {
        roster,
        ineligible: roster.filter((player) => isIneligibleIR(player) && player.id !== excludeRosterId),
    }
}

/** The member's weekly add state, or null when it cannot load: a pickup still goes to the server, which explains any block. */
export async function loadAddLimitState(memberId: string, leagueId: string): Promise<MemberTransactionState | null> {
    try {
        return await getMemberTransactionState(memberId, leagueId)
    } catch (error) {
        console.warn('Could not load the weekly add state.', error)
        return null
    }
}

/** Roster status first; the weekly add state only once the player turns out to be pick-up-able. */
export async function loadPickupState(
    playerId: string,
    memberId: string,
    leagueId: string,
): Promise<{ status: PlayerRosterStatus; transactionState: MemberTransactionState | null }> {
    const status = await getPlayerRosterStatus(playerId, memberId, leagueId)
    const pickupPossible = status.status === 'free_agent' || status.status === 'on_waivers'
    return { status, transactionState: pickupPossible ? await loadAddLimitState(memberId, leagueId) : null }
}

export async function addFreeAgentOrRequestDrop(
    memberId: string,
    leagueId: string,
    playerId: string,
    roster: RosterPlayer[],
): Promise<{ status: 'added' } | { status: 'roster_full'; activeRoster: RosterPlayer[] }> {
    try {
        await addFreeAgent(memberId, leagueId, playerId)
        return { status: 'added' }
    } catch (error) {
        if (errorCode(error) !== RULE_CODES.rosterFull) throw error
        return {
            status: 'roster_full',
            activeRoster: roster.filter((player) => !player.is_on_ir && !player.is_on_taxi),
        }
    }
}

export async function resolveRosterAddIRConflict({
    memberId,
    leagueId,
    activatePlayer,
    dropPlayer,
}: {
    memberId: string
    leagueId: string
    activatePlayer: RosterPlayer
    dropPlayer?: RosterPlayer
}): Promise<
    | { status: 'locked'; message: string }
    | { status: 'resolved'; roster: RosterPlayer[]; remaining: RosterPlayer[] }
> {
    const lockMessage = await getRosterStatusChangeLockMessage(activatePlayer)
    if (lockMessage) return { status: 'locked', message: lockMessage }

    if (dropPlayer) {
        await activateRosterPlayerWithOverflow(activatePlayer.id, 'ir', dropPlayer.id, 'drop')
    } else {
        await toggleIR(activatePlayer.id, false)
    }

    const roster = await getRoster(memberId, leagueId)
    return {
        status: 'resolved',
        roster,
        remaining: roster.filter((player) => isIneligibleIR(player)),
    }
}

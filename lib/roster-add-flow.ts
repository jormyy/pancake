import { isIneligibleIR } from '@/lib/format'
import {
    activateRosterPlayerWithOverflow,
    addFreeAgent,
    getPlayerRosterStatus,
    getRoster,
    pickupPossible,
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

/** Roster status first; the weekly add state only once the player turns out to be pick-up-able, and never at the cost of the status. */
export async function loadPickupState(
    playerId: string,
    memberId: string,
    leagueId: string,
): Promise<{ status: PlayerRosterStatus; transactionState: MemberTransactionState | null }> {
    const status = await getPlayerRosterStatus(playerId, memberId, leagueId)
    if (!pickupPossible(status)) return { status, transactionState: null }
    try {
        return { status, transactionState: await getMemberTransactionState(memberId, leagueId) }
    } catch (error) {
        console.warn('Could not load the weekly add state.', error)
        return { status, transactionState: null }
    }
}

export async function addFreeAgentOrRequestDrop(
    memberId: string,
    leagueId: string,
    playerId: string,
    roster?: RosterPlayer[],
): Promise<{ status: 'added' } | { status: 'roster_full'; activeRoster: RosterPlayer[] }> {
    try {
        await addFreeAgent(memberId, leagueId, playerId)
        return { status: 'added' }
    } catch (error) {
        if (errorCode(error) !== RULE_CODES.rosterFull) throw error
        const current = roster ?? await getRoster(memberId, leagueId)
        return {
            status: 'roster_full',
            activeRoster: current.filter((player) => !player.is_on_ir && !player.is_on_taxi),
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

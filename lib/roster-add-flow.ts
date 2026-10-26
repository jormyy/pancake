import { assertReadActive } from '@/lib/shared/read-admission'
import { getRosterProblems, type RosterProblem } from '@/lib/roster-problems'
import {
    activateRosterPlayerWithOverflow,
    addFreeAgent,
    getPlayerRosterContext,
    getRoster,
    toggleIR,
    toggleTaxi,
    getTaxiExitPlayerIds,
    type PlayerRosterStatus,
    type RosterOccupancy,
    type RosterPlayer,
} from '@/lib/roster'
import { getRosterStatusChangeLockMessage } from '@/lib/roster-locks'
import { RULE_CODES, errorCode } from '@/lib/shared/errors'
import { getCurrentSeasonId } from '@/lib/shared/season'
import { getPendingWaiverPlayerIdsForSeason } from '@/lib/waivers'
import { getMemberTransactionState, type MemberTransactionState } from '@/lib/league'

export async function loadRosterAddGate(
    memberId: string,
    leagueId: string,
    excludeRosterId?: string,
    rosterSize = 20,
    includeTaxiExits = false,
): Promise<{ roster: RosterPlayer[]; ineligible: RosterPlayer[]; problems: RosterProblem[]; taxiExitIds: Set<string> }> {
    const [roster, taxiExitIds] = await Promise.all([getRoster(memberId, leagueId), includeTaxiExits ? getTaxiExitPlayerIds(memberId, leagueId) : Promise.resolve(new Set<string>())])
    const problems = getRosterProblems(roster, rosterSize).filter(problem => !problem.player || problem.player.id !== excludeRosterId)
    return { roster, taxiExitIds, problems, ineligible: problems.flatMap(problem => problem.player ? [problem.player] : []) }
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
    canRead?: () => boolean,
    pickupHint = false,
): Promise<{ status: PlayerRosterStatus; transactionState: MemberTransactionState | null; claimPending: boolean; roster: RosterOccupancy[] }> {
    assertReadActive(canRead)
    const knownPickupState = pickupHint ? loadAddLimitState(memberId, leagueId) : null
    const { status, roster } = await getPlayerRosterContext(playerId, memberId, leagueId, canRead)
    assertReadActive(canRead)
    const pickupPossible = status.status === 'free_agent' || status.status === 'on_waivers'
    const [transactionState, pendingIds] = await Promise.all([
        pickupPossible ? knownPickupState ?? loadAddLimitState(memberId, leagueId) : Promise.resolve(null),
        pickupPossible ? getCurrentSeasonId(leagueId).then((seasonId) => {
            assertReadActive(canRead)
            return seasonId ? getPendingWaiverPlayerIdsForSeason(memberId, seasonId) : new Set<string>()
        }) : Promise.resolve(new Set<string>()),
    ])
    return { status, transactionState, claimPending: pendingIds.has(playerId), roster }
}

export async function addFreeAgentOrRequestDrop(
    memberId: string,
    leagueId: string,
    playerId: string,
    roster: RosterPlayer[],
    toIr = false,
    toTaxi = false,
): Promise<{ status: 'added' } | { status: 'roster_full'; activeRoster: RosterPlayer[] }> {
    try {
        if (toTaxi) await addFreeAgent(memberId, leagueId, playerId, toIr, toTaxi)
        else await addFreeAgent(memberId, leagueId, playerId, toIr)
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
    rosterSize = 20,
}: {
    memberId: string
    leagueId: string
    activatePlayer: RosterPlayer
    dropPlayer?: RosterPlayer
    rosterSize?: number
}): Promise<
    | { status: 'locked'; message: string }
    | { status: 'resolved'; roster: RosterPlayer[]; remaining: RosterPlayer[] }
> {
    const lockMessage = await getRosterStatusChangeLockMessage(activatePlayer)
    if (lockMessage) return { status: 'locked', message: lockMessage }

    if (dropPlayer) {
        await activateRosterPlayerWithOverflow(activatePlayer.id, activatePlayer.is_on_taxi ? 'taxi' : 'ir', dropPlayer.id, 'drop')
    } else if (activatePlayer.is_on_taxi) {
        await toggleTaxi(activatePlayer.id, false)
    } else {
        await toggleIR(activatePlayer.id, false)
    }

    const roster = await getRoster(memberId, leagueId)
    return {
        status: 'resolved',
        roster,
        remaining: getRosterProblems(roster, rosterSize).flatMap(problem => problem.player ? [problem.player] : []),
    }
}

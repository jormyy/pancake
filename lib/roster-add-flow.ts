import { cachedScreenView, readScreenView } from '@/lib/cache/screen-cache'
import { screenScope } from '@/lib/cache/screen-scope'
import type { PlayerView } from '@/lib/cache/view-types'
import { currentSeasonYear } from '@/lib/shared/season'
import { assertReadActive } from '@/lib/shared/read-admission'
import { getRosterProblems, type RosterProblem } from '@/lib/roster-problems'
import { activateRosterPlayerWithOverflow, addFreeAgent, getRoster, toggleIR, toggleTaxi, getTaxiExitPlayerIds, type PlayerRosterStatus, type RosterOccupancy, type RosterPlayer } from '@/lib/roster'
import { getRosterStatusChangeLockMessage } from '@/lib/roster-locks'
import { RULE_CODES, errorCode } from '@/lib/shared/errors'


import type { MemberTransactionState } from '@/lib/league'

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

/** Roster status first; the weekly add state only once the player turns out to be pick-up-able. */
export async function loadPickupState(
    playerId: string,
    memberId: string,
    leagueId: string,
    canRead?: () => boolean,
    pickupHint = false,
): Promise<{ status: PlayerRosterStatus; transactionState: MemberTransactionState | null; claimPending: boolean; roster: RosterOccupancy[] }> {
    assertReadActive(canRead)
    const scope = screenScope('player', leagueId, memberId, { playerId, seasonYear: currentSeasonYear() })
    const view = cachedScreenView<PlayerView>(scope)?.value ?? await readScreenView<PlayerView>(scope)
    assertReadActive(canRead)
    const own = view.roster.roster.find(row => row.players.id === playerId)
    const claimPending = view.roster.claims.some(claim => claim.playerId === playerId && claim.status === 'pending')
    const ownership = (view as PlayerView & { ownership?: { memberId: string; teamName: string; isOnTaxi: boolean } | null; clearsAt?: string | null }).ownership
    const clearsAt = (view as PlayerView & { clearsAt?: string | null }).clearsAt
    const status: PlayerRosterStatus = own ? { status: 'mine', rosterPlayerId: own.id, isOnTaxi: own.is_on_taxi }
        : ownership ? { status: 'taken', ownerTeamName: ownership.teamName, isOnTaxi: ownership.isOnTaxi }
        : clearsAt ? { status: 'on_waivers', logId: '', clearsAt } : { status: 'free_agent' }
    return { status, transactionState: view.roster.transactionState, claimPending, roster: view.roster.roster }

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

import { canPlaySlot } from '@/constants/slots'
import type { LineupPlayer, LineupSlot, LineupSlotMove } from './read'
import { isIREligible } from '@pancake/core'

export type LineupSelection =
    | { kind: 'starter'; index: number }
    | { kind: 'bench'; index: number }
    | { kind: 'ir'; index: number }
    | { kind: 'taxi'; index: number }

export type LineupMoveData = {
    starters: LineupSlot[]
    bench: LineupPlayer[]
    ir?: LineupPlayer[]
    taxi?: LineupPlayer[]
}

type ActivationSource = 'ir' | 'taxi'

type LineupMovePlan =
    | { kind: 'invalid'; title: string; message: string }
    | { kind: 'overflow'; rosterPlayerId: string; source: ActivationSource; slotType: string | null }
    | {
          kind: 'activate'
          activateRosterPlayerId: string
          activateSource: ActivationSource
          freeRosterPlayerId: string | null
          freeAction: 'ir' | 'taxi' | null
          slotType: string | null
      }
    | { kind: 'toggle-ir'; rosterPlayerId: string }
    | { kind: 'toggle-taxi'; rosterPlayerId: string }
    | { kind: 'slot-moves'; moves: LineupSlotMove[] }

export type LineupMoveTargetState = 'valid' | 'invalid' | null

function selectedPlayer(lineup: LineupMoveData, selection: LineupSelection): LineupPlayer | null {
    if (selection.kind === 'starter') return lineup.starters[selection.index]?.player ?? null
    if (selection.kind === 'bench') return lineup.bench[selection.index] ?? null
    if (selection.kind === 'ir') return lineup.ir?.[selection.index] ?? null
    return lineup.taxi?.[selection.index] ?? null
}

function selectedSlot(lineup: LineupMoveData, selection: LineupSelection): string {
    if (selection.kind === 'starter') return lineup.starters[selection.index]?.slotType ?? 'BE'
    if (selection.kind === 'bench') return 'BE'
    if (selection.kind === 'ir') return 'IR'
    return 'TX'
}

function activationSlotType(lineup: LineupMoveData, target: LineupSelection, player: LineupPlayer | null): string | null {
    if (!player || target.kind !== 'starter') return null
    const slotType = lineup.starters[target.index]?.slotType
    return slotType && canPlaySlot(player.eligiblePositions, slotType) ? slotType : null
}

function activeRosterCount(lineup: LineupMoveData): number {
    return lineup.starters.filter((slot) => slot.player !== null).length + lineup.bench.length
}

export function planLineupMove({
    lineup,
    league,
    startedTeams,
    from,
    to,
}: {
    lineup: LineupMoveData
    league: { roster_size?: number; taxi_slots?: number }
    startedTeams: ReadonlySet<string>
    from: LineupSelection
    to: LineupSelection
}): LineupMovePlan {
    const aPlayer = selectedPlayer(lineup, from)
    const bPlayer = selectedPlayer(lineup, to)
    const aSlot = selectedSlot(lineup, from)
    const bSlot = selectedSlot(lineup, to)
    const lockedPlayer =
        aPlayer?.nbaTeam && startedTeams.has(aPlayer.nbaTeam)
            ? aPlayer
            : bPlayer?.nbaTeam && startedTeams.has(bPlayer.nbaTeam)
              ? bPlayer
              : null
    if (lockedPlayer) {
        return {
            kind: 'invalid',
            title: 'Lineup locked',
            message: `${lockedPlayer.displayName}'s game has already started. No lineup changes are allowed once a game begins.`,
        }
    }

    if ((aSlot === 'IR' && bSlot === 'TX') || (aSlot === 'TX' && bSlot === 'IR')) {
        return { kind: 'invalid', title: 'Invalid move', message: 'Cannot swap directly between IR and Taxi Squad.' }
    }

    if (aSlot === 'IR' || bSlot === 'IR') {
        const irSelection = aSlot === 'IR' ? from : to
        const activeSelection = aSlot === 'IR' ? to : from
        const irPlayer = selectedPlayer(lineup, irSelection)
        const activePlayer = selectedPlayer(lineup, activeSelection)

        if (activePlayer && !isIREligible(activePlayer.injuryStatus)) {
            return {
                kind: 'invalid',
                title: 'Not eligible',
                message: `${activePlayer.displayName} must be OUT or IR-designated to be placed on Injured Reserve.`,
            }
        }

        if (irPlayer && !activePlayer && activeRosterCount(lineup) >= (league.roster_size ?? 20)) {
            return {
                kind: 'overflow',
                rosterPlayerId: irPlayer.rosterPlayerId,
                source: 'ir',
                slotType: activationSlotType(lineup, activeSelection, irPlayer),
            }
        }

        if (irPlayer) {
            return {
                kind: 'activate',
                activateRosterPlayerId: irPlayer.rosterPlayerId,
                activateSource: 'ir',
                freeRosterPlayerId: activePlayer?.rosterPlayerId ?? null,
                freeAction: activePlayer ? 'ir' : null,
                slotType: activationSlotType(lineup, activeSelection, irPlayer),
            }
        }
        if (activePlayer) return { kind: 'toggle-ir', rosterPlayerId: activePlayer.rosterPlayerId }
    }

    if (aSlot === 'TX' || bSlot === 'TX') {
        const taxiSelection = aSlot === 'TX' ? from : to
        const activeSelection = aSlot === 'TX' ? to : from
        const taxiPlayer = selectedPlayer(lineup, taxiSelection)
        const activePlayer = selectedPlayer(lineup, activeSelection)

        if (activePlayer && !taxiPlayer) {
            const taxiLimit = league.taxi_slots ?? 0
            if (taxiLimit === 0) {
                return { kind: 'invalid', title: 'Taxi squad disabled', message: 'This league has no taxi squad slots configured.' }
            }
            if ((lineup.taxi ?? []).length >= taxiLimit) {
                return { kind: 'invalid', title: 'Taxi squad full', message: `Your taxi squad is full (${taxiLimit} slots).` }
            }
        }

        if (taxiPlayer && !activePlayer && activeRosterCount(lineup) >= (league.roster_size ?? 20)) {
            return {
                kind: 'overflow',
                rosterPlayerId: taxiPlayer.rosterPlayerId,
                source: 'taxi',
                slotType: activationSlotType(lineup, activeSelection, taxiPlayer),
            }
        }

        if (taxiPlayer) {
            return {
                kind: 'activate',
                activateRosterPlayerId: taxiPlayer.rosterPlayerId,
                activateSource: 'taxi',
                freeRosterPlayerId: activePlayer?.rosterPlayerId ?? null,
                freeAction: activePlayer ? 'taxi' : null,
                slotType: activationSlotType(lineup, activeSelection, taxiPlayer),
            }
        }
        if (activePlayer) return { kind: 'toggle-taxi', rosterPlayerId: activePlayer.rosterPlayerId }
    }

    if (aPlayer && bSlot !== 'BE' && !canPlaySlot(aPlayer.eligiblePositions, bSlot)) {
        return { kind: 'invalid', title: 'Invalid move', message: `${aPlayer.displayName} can't play ${bSlot}` }
    }
    if (bPlayer && aSlot !== 'BE' && !canPlaySlot(bPlayer.eligiblePositions, aSlot)) {
        return { kind: 'invalid', title: 'Invalid move', message: `${bPlayer.displayName} can't play ${aSlot}` }
    }

    return {
        kind: 'slot-moves',
        moves: [
            ...(aPlayer ? [{ playerId: aPlayer.playerId, slotType: bSlot }] : []),
            ...(bPlayer ? [{ playerId: bPlayer.playerId, slotType: aSlot }] : []),
        ],
    }
}

export function getLineupMoveTargetState({
    lineup,
    league,
    startedTeams,
    from,
    to,
}: {
    lineup: LineupMoveData
    league: { roster_size?: number; taxi_slots?: number }
    startedTeams: ReadonlySet<string>
    from: LineupSelection | null
    to: LineupSelection
}): LineupMoveTargetState {
    if (!from || (from.kind === to.kind && from.index === to.index)) return null
    if (selectedSlot(lineup, from) === selectedSlot(lineup, to)) return 'invalid'
    return planLineupMove({ lineup, league, startedTeams, from, to }).kind === 'invalid'
        ? 'invalid'
        : 'valid'
}

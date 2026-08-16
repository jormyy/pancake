import { describe, expect, it } from 'vitest'
import { getLineupMoveTargetState, planLineupMove, type LineupMoveData } from '@/lib/lineup/movePlan'
import type { LineupPlayer } from '@/lib/lineup/read'

function player(
    id: string,
    eligiblePositions: string[] = ['PG'],
    overrides: Partial<LineupPlayer> = {},
): LineupPlayer {
    return {
        rosterPlayerId: `rp-${id}`,
        playerId: id,
        displayName: `Player ${id}`,
        position: eligiblePositions[0] ?? null,
        eligiblePositions,
        nbaTeam: 'LAL',
        injuryStatus: null,
        nbaId: null,
        ...overrides,
    }
}

function lineup(overrides: Partial<LineupMoveData> = {}): LineupMoveData {
    return {
        starters: [],
        bench: [],
        ir: [],
        taxi: [],
        ...overrides,
    }
}

describe('planLineupMove', () => {
    it('blocks moves after either selected player has started', () => {
        const plan = planLineupMove({
            lineup: lineup({
                starters: [{ slotType: 'PG', player: player('started', ['PG'], { nbaTeam: 'LAL' }) }],
                bench: [player('bench', ['PG'], { nbaTeam: 'BOS' })],
            }),
            league: { roster_size: 10, taxi_slots: 1 },
            startedTeams: new Set(['LAL']),
            from: { kind: 'starter', index: 0 },
            to: { kind: 'bench', index: 0 },
        })

        expect(plan).toMatchObject({ kind: 'invalid', title: 'Lineup locked' })
    })

    it('rejects direct injured-reserve to taxi-squad swaps', () => {
        const plan = planLineupMove({
            lineup: lineup({
                ir: [player('ir')],
                taxi: [player('taxi')],
            }),
            league: { roster_size: 10, taxi_slots: 1 },
            startedTeams: new Set(),
            from: { kind: 'ir', index: 0 },
            to: { kind: 'taxi', index: 0 },
        })

        expect(plan).toEqual({
            kind: 'invalid',
            title: 'Invalid move',
            message: 'Cannot swap directly between IR and Taxi Squad.',
        })
    })

    it('plans valid slot moves and rejects incompatible starter slots', () => {
        const valid = planLineupMove({
            lineup: lineup({
                starters: [{ slotType: 'C', player: null }],
                bench: [player('center', ['C'])],
            }),
            league: { roster_size: 10, taxi_slots: 1 },
            startedTeams: new Set(),
            from: { kind: 'bench', index: 0 },
            to: { kind: 'starter', index: 0 },
        })
        expect(valid).toEqual({ kind: 'slot-moves', moves: [{ playerId: 'center', slotType: 'C' }] })

        const invalid = planLineupMove({
            lineup: lineup({
                starters: [{ slotType: 'C', player: null }],
                bench: [player('guard', ['PG'])],
            }),
            league: { roster_size: 10, taxi_slots: 1 },
            startedTeams: new Set(),
            from: { kind: 'bench', index: 0 },
            to: { kind: 'starter', index: 0 },
        })
        expect(invalid).toMatchObject({ kind: 'invalid', title: 'Invalid move' })
    })

    it('plans injured-reserve activation and preserves the target starter slot when playable', () => {
        const plan = planLineupMove({
            lineup: lineup({
                starters: [{ slotType: 'PG', player: null }],
                bench: [],
                ir: [player('ir-guard', ['PG'], { injuryStatus: 'Out' })],
            }),
            league: { roster_size: 10, taxi_slots: 1 },
            startedTeams: new Set(),
            from: { kind: 'ir', index: 0 },
            to: { kind: 'starter', index: 0 },
        })

        expect(plan).toEqual({
            kind: 'activate',
            activateRosterPlayerId: 'rp-ir-guard',
            activateSource: 'ir',
            freeRosterPlayerId: null,
            freeAction: null,
            slotType: 'PG',
        })
    })

    it('requires overflow resolution when activating without active roster space', () => {
        const plan = planLineupMove({
            lineup: lineup({
                starters: [
                    { slotType: 'PG', player: null },
                    { slotType: 'SG', player: player('starter', ['SG']) },
                ],
                bench: [player('bench')],
                ir: [player('ir-guard', ['PG'], { injuryStatus: 'Out' })],
            }),
            league: { roster_size: 2, taxi_slots: 1 },
            startedTeams: new Set(),
            from: { kind: 'ir', index: 0 },
            to: { kind: 'starter', index: 0 },
        })

        expect(plan).toEqual({
            kind: 'overflow',
            rosterPlayerId: 'rp-ir-guard',
            source: 'ir',
            slotType: 'PG',
        })
    })

    it('keeps taxi-slot validation in the planner', () => {
        const fullTaxi = planLineupMove({
            lineup: lineup({
                bench: [player('bench')],
                taxi: [player('taxi')],
            }),
            league: { roster_size: 10, taxi_slots: 1 },
            startedTeams: new Set(),
            from: { kind: 'bench', index: 0 },
            to: { kind: 'taxi', index: 1 },
        })
        expect(fullTaxi).toMatchObject({ kind: 'invalid', title: 'Taxi squad full' })

        const availableTaxi = planLineupMove({
            lineup: lineup({ bench: [player('bench')], taxi: [] }),
            league: { roster_size: 10, taxi_slots: 1 },
            startedTeams: new Set(),
            from: { kind: 'bench', index: 0 },
            to: { kind: 'taxi', index: 0 },
        })
        expect(availableTaxi).toEqual({ kind: 'toggle-taxi', rosterPlayerId: 'rp-bench' })
    })
})

describe('getLineupMoveTargetState', () => {
    const moveLineup = lineup({
        starters: [
            { slotType: 'PG', player: player('guard', ['PG']) },
            { slotType: 'C', player: player('center', ['C']) },
            { slotType: 'UTIL', player: null },
        ],
        bench: [player('bench-guard', ['PG'])],
    })
    const base = {
        lineup: moveLineup,
        league: { roster_size: 10, taxi_slots: 1 },
        startedTeams: new Set<string>(),
    }

    it('marks only legal destinations as valid', () => {
        expect(getLineupMoveTargetState({
            ...base,
            from: { kind: 'bench', index: 0 },
            to: { kind: 'starter', index: 0 },
        })).toBe('valid')
        expect(getLineupMoveTargetState({
            ...base,
            from: { kind: 'bench', index: 0 },
            to: { kind: 'starter', index: 1 },
        })).toBe('invalid')
        expect(getLineupMoveTargetState({
            ...base,
            from: { kind: 'bench', index: 0 },
            to: { kind: 'starter', index: 2 },
        })).toBe('valid')
    })

    it('does not offer no-op moves', () => {
        expect(getLineupMoveTargetState({
            ...base,
            from: { kind: 'bench', index: 0 },
            to: { kind: 'bench', index: 0 },
        })).toBeNull()
        expect(getLineupMoveTargetState({
            ...base,
            from: { kind: 'bench', index: 0 },
            to: { kind: 'bench', index: 1 },
        })).toBe('invalid')
    })
})

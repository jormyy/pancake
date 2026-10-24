import { describe, expect, it } from 'vitest'
import { arrangeActiveRoster, compareRosterBySlot, rosterSlotLabel } from '@/lib/roster-slots'
import type { RosterPlayer } from '@/lib/roster'

const player = (id: string) => ({ players: { id } })
const rows = (result: ReturnType<typeof arrangeActiveRoster<{ players: { id: string } }>>) => ({
    starters: result.starters.map((row) => [row.slotType, row.player?.players.id ?? null]),
    bench: result.bench.map((row) => row.player?.players.id ?? null),
})

it('sorts roster players by eligible role, name, primary fallback, then unknown role', () => {
    const rosterPlayer = (name: string, eligible: string[], position: string | null = null) => ({
        players: { display_name: name, eligible_positions: eligible, position },
    }) as RosterPlayer
    const players = [
        rosterPlayer('Unknown', []), rosterPlayer('Center', ['C']), rosterPlayer('Guard Z', ['SG', 'PG']),
        rosterPlayer('Guard A', [], 'PG'), rosterPlayer('Forward', ['F', 'PF']),
    ]
    expect(players.sort(compareRosterBySlot).map(player => player.players.display_name)).toEqual([
        'Guard A', 'Guard Z', 'Forward', 'Center', 'Unknown',
    ])
})

describe('arrangeActiveRoster', () => {
    const plan = (assignments: Record<string, string>) => ({
        slots: [
            { slotType: 'UTIL', slotCount: 1 }, { slotType: 'C', slotCount: 1 }, { slotType: 'G', slotCount: 1 },
            { slotType: 'PG', slotCount: 1 }, { slotType: 'BE', slotCount: 3 }, { slotType: 'IR', slotCount: 2 },
        ],
        assignments,
    })

    it('orders starting slots by role and pads the bench to the active roster limit', () => {
        const result = arrangeActiveRoster([player('a'), player('b'), player('c')], plan({ a: 'C', b: 'PG', c: 'BE' }), 7)
        expect(rows(result)).toEqual({
            starters: [['PG', 'b'], ['G', null], ['C', 'a'], ['UTIL', null]],
            bench: ['c', null, null],
        })
    })

    it('benches players whose assigned slot has no remaining capacity or is a reserve slot', () => {
        const result = arrangeActiveRoster([player('a'), player('b'), player('c')], plan({ a: 'PG', b: 'PG', c: 'IR' }), 4)
        expect(rows(result)).toEqual({ starters: [['PG', 'a'], ['G', null], ['C', null], ['UTIL', null]], bench: ['b', 'c'] })
    })

    it('lists every active player on the bench when no lineup is known', () => {
        expect(rows(arrangeActiveRoster([player('a')], undefined, 3))).toEqual({ starters: [], bench: ['a', null, null] })
    })

    it('labels reserve slots for the slot column', () => {
        expect(['PG', 'UTIL', 'BE', 'IR', 'TX'].map(rosterSlotLabel)).toEqual(['PG', 'UTIL', 'BENCH', 'IR', 'TAXI'])
    })
})

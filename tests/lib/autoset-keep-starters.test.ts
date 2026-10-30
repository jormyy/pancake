import { describe, expect, it } from 'vitest'
import { LINEUP_SLOT_ALLOWED_POSITIONS } from '@pancake/core'

const assignmentModule = '../../supabase/functions/_shared/autoSetAssignments.ts'
const { chooseAutoSetAssignments } = await import(assignmentModule) as {
    chooseAutoSetAssignments: (slots: string[], players: ReturnType<typeof player>[],
        hasGame: (p: ReturnType<typeof player>) => boolean, stored: ReturnType<typeof current>[]) => ReturnType<typeof current>[]
}

const player = (playerId: string, eligiblePositions: string[], projected: number, hasGame = false) => ({
    playerId, eligiblePositions, projected, hasGame, avoidInLineup: false,
})
const current = (playerId: string, slotType: string) => ({ playerId, slotType })
const optimize = (slots: string[], players: ReturnType<typeof player>[], stored: ReturnType<typeof current>[] = []) =>
    chooseAutoSetAssignments(slots, players, p => p.hasGame, stored)

describe('auto-set keeps starting slots occupied', () => {
    it('keeps a no-game starter when a bench player cannot improve the day', () => {
        expect(optimize(['PF'], [player('starter', ['PF'], 15), player('bench', ['PF'], 50)], [current('starter', 'PF')]))
            .toEqual([current('starter', 'PF')])
    })

    it('replaces a no-game starter with an eligible playing bench player', () => {
        expect(optimize(['PF'], [player('starter', ['PF'], 50), player('bench', ['PF'], 15, true)], [current('starter', 'PF')]))
            .toEqual([current('bench', 'PF')])
    })

    it('uses a higher playing projection and keeps equal playing projections stable', () => {
        for (const projected of [20, 30]) {
            expect(optimize(['PG'], [player('starter', ['PG'], 20, true), player('bench', ['PG'], projected, true)], [current('starter', 'PG')]))
                .toEqual([current(projected === 20 ? 'starter' : 'bench', 'PG')])
        }
    })

    it('fills empty slots with the best eligible no-game bench player', () => {
        expect(optimize(['C'], [player('best', ['C'], 30), player('other', ['C'], 10), player('ineligible', ['PG'], 100)]))
            .toEqual([current('best', 'C')])
    })

    it('uses positional slots before UTIL regardless of input order', () => {
        for (const stored of [[], [current('guard', 'UTIL')]]) {
            expect(optimize(['UTIL', 'PG'], [player('guard', ['PG'], 30)], stored))
                .toEqual([current('guard', 'PG')])
        }
    })

    it('maximizes playing points before fallback projections and handles flexible positions', () => {
        const roster = [player('flex', ['PG', 'SF'], 50, true), player('guard', ['PG'], 40, true), player('forward', ['SF'], 100)]
        const result = optimize(['PG', 'SF'], roster)
        expect(new Set(result.map(entry => entry.playerId))).toEqual(new Set(['flex', 'guard']))
        expect(result).toContainEqual(current('flex', 'SF'))
    })

    it('leaves only unfillable positions empty and never duplicates players', () => {
        const roster = [player('guard', ['PG'], 15), player('center', ['C'], 20)]
        const result = optimize(['PG', 'SG', 'PF', 'C', 'UTIL'], roster)
        expect(result).toHaveLength(2)
        expect(new Set(result.map(entry => entry.playerId)).size).toBe(2)
        for (const entry of result) {
            const allowed = LINEUP_SLOT_ALLOWED_POSITIONS[entry.slotType as keyof typeof LINEUP_SLOT_ALLOWED_POSITIONS] as readonly string[]
            expect(roster.find(p => p.playerId === entry.playerId)?.eligiblePositions.some(position => allowed.includes(position))).toBe(true)
        }
    })

    it('keeps a zero-point no-game starter over a negative playing projection', () => {
        expect(optimize(['PG'], [player('starter', ['PG'], 20), player('negative', ['PG'], -10, true)], [current('starter', 'PG')]))
            .toEqual([current('starter', 'PG')])
    })

    it('fills zero and negative projection slots without removing their starters', () => {
        for (const projected of [0, -10]) {
            expect(optimize(['PG'], [player('starter', ['PG'], projected, true)], [current('starter', 'PG')]))
                .toEqual([current('starter', 'PG')])
        }
    })
})

const fixture = await import('../fixtures/autoset-michael.json')
for (const day of fixture.days) {
    it(`fills Michael's ${day.date} lineup without lowering playing projections`, () => {
        const teams = new Set(day.games.flatMap(game => [game.homeTeam, game.awayTeam]))
        const projections = new Map(day.projections.map(row => [row.player_id, row.projection_fantasy_points]))
        const roster = fixture.roster.filter(p => !p.isOnIr && !p.isOnTaxi).map(p => ({
            ...player(p.playerId, p.eligiblePositions, projections.get(p.playerId) ?? 0, teams.has(p.nbaTeam)),
            avoidInLineup: p.injuryStatus?.toLowerCase() === 'out' || !!p.injuryStatus?.toLowerCase().startsWith('ir'),
        }))
        const slots = fixture.templates.flatMap(template => Array<string>(template.count).fill(template.slotType))
        const stored = day.stored.map(entry => current(entry.player_id, entry.slot_type))
        const result = optimize(slots, roster, stored)
        expect(result).toHaveLength(10)
        expect(new Set(result.map(entry => entry.playerId)).size).toBe(10)
        expect(optimize(slots, roster, result)).toEqual(result)
        const active = roster.filter(p => p.hasGame && !p.avoidInLineup)
        const total = result.reduce((sum, entry) => sum + (active.find(p => p.playerId === entry.playerId)?.projected ?? 0), 0)
        expect(total).toBeGreaterThan(0)
        if (active.length <= 10) expect(result.map(entry => entry.playerId)).toEqual(expect.arrayContaining(active.map(p => p.playerId)))
    })
}

it('matches an exhaustive playing-points optimum across sparse flexible rosters', () => {
    let seed = 27
    const random = () => (seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 4294967296
    const positions = ['PG', 'SG', 'SF', 'PF', 'C']
    const slots = ['PG', 'G', 'F', 'UTIL']
    for (let trial = 0; trial < 200; trial++) {
        const roster = Array.from({ length: 6 }, (_, i) => ({
            ...player(String(i), positions.filter(() => random() < 0.4), Math.floor(random() * 40), random() < 0.5),
            avoidInLineup: random() < 0.15,
        }))
        const allowed = (slot: string, p: ReturnType<typeof player>) => p.eligiblePositions.some(position =>
            (LINEUP_SLOT_ALLOWED_POSITIONS[slot as keyof typeof LINEUP_SLOT_ALLOWED_POSITIONS] as readonly string[]).includes(position))
        const best = (index: number, used: Set<string>): number => {
            if (index === slots.length) return 0
            let score = best(index + 1, used)
            for (const p of roster) {
                if (used.has(p.playerId) || !allowed(slots[index], p)) continue
                score = Math.max(score, (p.hasGame && !p.avoidInLineup ? p.projected : 0) + best(index + 1, new Set([...used, p.playerId])))
            }
            return score
        }
        const result = optimize(slots, roster)
        const score = result.reduce((sum, entry) => {
            const p = roster.find(p => p.playerId === entry.playerId)!
            expect(allowed(entry.slotType, p)).toBe(true)
            return sum + (p.hasGame && !p.avoidInLineup ? p.projected : 0)
        }, 0)
        expect(score).toBe(best(0, new Set()))
        expect(new Set(result.map(entry => entry.playerId)).size).toBe(result.length)
    }
})

import { beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('../src/lib/supabase', () => ({ supabase: { from: vi.fn() } }))

import { supabase } from '../src/lib/supabase'
import { generateMatchups, roundRobinRounds } from '../src/sync/matchups'

const mockFrom = vi.mocked(supabase.from)

function q(result: { data?: any; error?: any; count?: number | null }, onInsert?: (rows: any[]) => void) {
    const chain: any = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        in: vi.fn(() => chain),
        order: vi.fn(() => chain),
        delete: vi.fn(() => chain),
        insert: vi.fn((rows: any[]) => {
            onInsert?.(rows)
            return Promise.resolve(result)
        }),
        then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
    }
    return chain
}

function queueQueries(results: Array<{ data?: any; error?: any; count?: number | null }>, onInsert?: (rows: any[]) => void) {
    mockFrom.mockImplementation(() => {
        const result = results.shift()
        if (!result) throw new Error('Unexpected Supabase query')
        return q(result, onInsert) as any
    })
}

beforeEach(() => {
    vi.clearAllMocks()
})

describe('roundRobinRounds', () => {
    it('generates 1 round for 2 teams with 1 matchup', () => {
        const rounds = roundRobinRounds(['A', 'B'])
        expect(rounds).toHaveLength(1)
        expect(rounds[0]).toHaveLength(1)
        expect(rounds[0][0]).toEqual({ home: 'A', away: 'B' })
    })

    it('generates 3 rounds for 4 teams, 2 matchups each', () => {
        const rounds = roundRobinRounds(['A', 'B', 'C', 'D'])
        expect(rounds).toHaveLength(3)
        rounds.forEach((round) => expect(round).toHaveLength(2))
    })

    it('each team plays every other team exactly once across all rounds (4 teams)', () => {
        const teams = ['A', 'B', 'C', 'D']
        const rounds = roundRobinRounds(teams)
        const played = new Map<string, Set<string>>()
        teams.forEach((t) => played.set(t, new Set()))

        for (const round of rounds) {
            for (const { home, away } of round) {
                played.get(home)!.add(away)
                played.get(away)!.add(home)
            }
        }

        for (const team of teams) {
            const opponents = played.get(team)!
            // Should have played every other team
            expect(opponents.size).toBe(teams.length - 1)
            for (const other of teams) {
                if (other !== team) expect(opponents.has(other)).toBe(true)
            }
        }
    })

    it('each team plays every other team exactly once (6 teams)', () => {
        const teams = ['A', 'B', 'C', 'D', 'E', 'F']
        const rounds = roundRobinRounds(teams)
        expect(rounds).toHaveLength(5)

        const played = new Map<string, Set<string>>()
        teams.forEach((t) => played.set(t, new Set()))

        for (const round of rounds) {
            for (const { home, away } of round) {
                played.get(home)!.add(away)
                played.get(away)!.add(home)
            }
        }

        for (const team of teams) {
            expect(played.get(team)!.size).toBe(5)
        }
    })

    it('handles odd number of teams with a bye week (3 teams → 3 rounds, 1 matchup each)', () => {
        const rounds = roundRobinRounds(['A', 'B', 'C'])
        expect(rounds).toHaveLength(3) // padded to 4, so 3 rounds
        // Each round has only 1 real matchup (one team gets bye)
        rounds.forEach((round) => {
            expect(round.length).toBe(1)
            // No bye slot leaks
            round.forEach(({ home, away }) => {
                expect(home).not.toBe('__bye__')
                expect(away).not.toBe('__bye__')
            })
        })
    })

    it('does not include __bye__ in any matchup', () => {
        const rounds = roundRobinRounds(['A', 'B', 'C', 'D', 'E'])
        for (const round of rounds) {
            for (const { home, away } of round) {
                expect(home).not.toBe('__bye__')
                expect(away).not.toBe('__bye__')
            }
        }
    })

    it('no team plays itself', () => {
        const teams = ['A', 'B', 'C', 'D']
        const rounds = roundRobinRounds(teams)
        for (const round of rounds) {
            for (const { home, away } of round) {
                expect(home).not.toBe(away)
            }
        }
    })

    it('no two teams play each other twice in the same round', () => {
        const teams = ['A', 'B', 'C', 'D', 'E', 'F']
        const rounds = roundRobinRounds(teams)
        for (const round of rounds) {
            const seen = new Set<string>()
            for (const { home, away } of round) {
                expect(seen.has(home)).toBe(false)
                expect(seen.has(away)).toBe(false)
                seen.add(home)
                seen.add(away)
            }
        }
    })
})

describe('generateMatchups force safety', () => {
    it('surfaces existing-matchup count failures before inserting a schedule', async () => {
        const insertedRows: any[] = []
        queueQueries([
            { data: [{ id: 'm1' }, { id: 'm2' }], error: null },
            { count: null, error: new Error('matchup count failed') },
        ], (rows) => insertedRows.push(...rows))

        await expect(generateMatchups('lg1', 'season1', 2)).rejects.toThrow('matchup count failed')

        expect(insertedRows).toHaveLength(0)
    })

    it('refuses to force-regenerate once finalized matchups exist', async () => {
        queueQueries([
            { data: [{ id: 'm1' }, { id: 'm2' }], error: null },
            { count: 1, error: null },
            { count: 1, error: null },
            { count: 0, error: null },
        ])

        await expect(generateMatchups('lg1', 'season1', 2, true)).rejects.toThrow(
            'Cannot force-regenerate matchups after finalized or playoff matchups exist.',
        )

        expect(mockFrom).toHaveBeenCalledTimes(4)
    })

    it('surfaces force-regeneration delete failures before inserting replacements', async () => {
        const insertedRows: any[] = []
        queueQueries([
            { data: [{ id: 'm1' }, { id: 'm2' }], error: null },
            { count: 1, error: null },
            { count: 0, error: null },
            { count: 0, error: null },
            { error: new Error('delete denied') },
        ], (rows) => insertedRows.push(...rows))

        await expect(generateMatchups('lg1', 'season1', 2, true)).rejects.toThrow('delete denied')

        expect(insertedRows).toHaveLength(0)
    })
})

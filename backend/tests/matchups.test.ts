import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/lib/supabase', () => ({ supabase: { from: vi.fn() } }))

import { roundRobinRounds } from '../src/sync/matchups'

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

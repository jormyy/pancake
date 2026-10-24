import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))
vi.mock('@/lib/shared/season', () => ({ getCurrentSeason: vi.fn() }))
vi.mock('@/lib/shared/week', () => ({ getCurrentWeekNumber: vi.fn() }))

import { compareStandingsRows, type StandingRow } from '@/lib/scoring'

function standing(overrides: Partial<StandingRow>): StandingRow {
    return {
        memberId: 'member', teamName: 'Team', wins: 0, losses: 0, ties: 0,
        pointsFor: 0, maxPointsFor: 0, pointsAgainst: 0, ...overrides,
    }
}

describe('standings with unequal games played', () => {
    it.each([
        ['win percentage', { wins: 2, losses: 0, pointsFor: 200 }, { wins: 3, losses: 1, pointsFor: 500 }],
        ['ties as half a win', { wins: 1, ties: 1, pointsFor: 200 }, { wins: 1, losses: 1, pointsFor: 500 }],
        ['points per game', { wins: 1, losses: 1, pointsFor: 220 }, { wins: 2, losses: 2, pointsFor: 400 }],
        ['maximum points after equal rates', { wins: 1, losses: 1, pointsFor: 200, maxPointsFor: 500 }, { wins: 2, losses: 2, pointsFor: 400, maxPointsFor: 400 }],
        ['points against after equal rates', { wins: 1, losses: 1, pointsFor: 200, pointsAgainst: 100 }, { wins: 2, losses: 2, pointsFor: 400, pointsAgainst: 200 }],
        ['team name before any games', { teamName: 'Alpha' }, { teamName: 'Beta' }],
        ['member ID after equal rates', { memberId: 'a' }, { memberId: 'b' }],
    ] satisfies [string, Partial<StandingRow>, Partial<StandingRow>][])('uses %s', (_label, first, second) => {
        const a = standing(first)
        const b = standing(second)
        expect(compareStandingsRows(a, b)).toBeLessThan(0)
        expect(compareStandingsRows(b, a)).toBeGreaterThan(0)
    })
})

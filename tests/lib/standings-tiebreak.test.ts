import { describe, it, expect, vi } from 'vitest'

// Mock supabase before importing anything that uses it
vi.mock('@/lib/supabase', () => ({
    supabase: { from: vi.fn() },
}))
vi.mock('@/lib/shared/season', () => ({
    getCurrentSeason: vi.fn(),
    getCurrentSeasonId: vi.fn(),
    getActiveSeasonId: vi.fn(),
    currentSeasonYear: vi.fn(),
}))

import { compareStandingsRows, type StandingRow } from '@/lib/scoring'

function row(overrides: Partial<StandingRow> = {}): StandingRow {
    return {
        memberId: 'm-base',
        teamName: 'Middling',
        wins: 5,
        losses: 5,
        ties: 0,
        pointsFor: 1000,
        pointsAgainst: 1000,
        maxPointsFor: 1200,
        ...overrides,
    }
}

// Precedence contract: wins DESC, pointsFor DESC, maxPointsFor DESC,
// pointsAgainst ASC, teamName ASC, memberId ASC. Each entry's `first`
// overrides make a row that must sort ahead of one built from `second`.
const precedence: { key: string; first: Partial<StandingRow>; second: Partial<StandingRow> }[] = [
    { key: 'wins DESC', first: { wins: 7 }, second: { wins: 6 } },
    { key: 'pointsFor DESC', first: { pointsFor: 1100 }, second: { pointsFor: 1050 } },
    { key: 'maxPointsFor DESC', first: { maxPointsFor: 1300 }, second: { maxPointsFor: 1250 } },
    { key: 'pointsAgainst ASC', first: { pointsAgainst: 900 }, second: { pointsAgainst: 950 } },
    { key: 'teamName ASC', first: { teamName: 'Alpha' }, second: { teamName: 'Zeta' } },
    { key: 'memberId ASC', first: { memberId: 'm-aaa' }, second: { memberId: 'm-bbb' } },
]

describe('compareStandingsRows precedence matrix', () => {
    it.each(precedence)('orders rows that differ only on $key', ({ first, second }) => {
        const a = row(first)
        const b = row(second)
        expect(compareStandingsRows(a, b)).toBeLessThan(0)
        expect(compareStandingsRows(b, a)).toBeGreaterThan(0)
        expect([...[b, a]].sort(compareStandingsRows)).toEqual([a, b])
    })

    it.each(precedence.slice(0, -1).map((entry, index) => ({
        higher: entry,
        lower: precedence[index + 1],
    })))('$higher.key beats $lower.key when they disagree', ({ higher, lower }) => {
        // A wins the higher-precedence key but loses the next key; A must still
        // sort first. Distinct memberIds oppose A unless memberId is the key
        // under test, so any accidental fallback would flip the order.
        const memberIdUnderTest = 'memberId' in { ...higher.first, ...lower.second }
        const a = row({ ...higher.first, ...lower.second, ...(memberIdUnderTest ? {} : { memberId: 'm-zzz' }) })
        const b = row({ ...higher.second, ...lower.first, ...(memberIdUnderTest ? {} : { memberId: 'm-aaa' }) })

        expect(compareStandingsRows(a, b)).toBeLessThan(0)
        expect(compareStandingsRows(b, a)).toBeGreaterThan(0)
    })

    it('breaks otherwise-identical rows deterministically by memberId', () => {
        const rows = [row({ memberId: 'm-3' }), row({ memberId: 'm-1' }), row({ memberId: 'm-2' })]
        const sorted = [...rows].sort(compareStandingsRows)
        expect(sorted.map((r) => r.memberId)).toEqual(['m-1', 'm-2', 'm-3'])

        expect(compareStandingsRows(row(), row())).toBe(0)
    })

})

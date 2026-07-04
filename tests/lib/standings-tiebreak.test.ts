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

const SEED = 0x5eed1e5

function mulberry32(seed: number): () => number {
    let a = seed >>> 0
    return () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

function shuffled<T>(items: T[], rng: () => number): T[] {
    const arr = [...items]
    for (let i = arr.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1))
        ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
    return arr
}

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

    it(`is stable under input permutation (seed ${SEED.toString(16)}, 50 shuffles)`, () => {
        // Tie ladders across every key so ordering must consult each tiebreak.
        const rows: StandingRow[] = [
            row({ memberId: 'm-01', wins: 8, pointsFor: 1200 }),
            row({ memberId: 'm-02', wins: 8, pointsFor: 1100, maxPointsFor: 1400 }),
            row({ memberId: 'm-03', wins: 8, pointsFor: 1100, maxPointsFor: 1300, pointsAgainst: 900 }),
            row({ memberId: 'm-04', wins: 8, pointsFor: 1100, maxPointsFor: 1300, pointsAgainst: 950, teamName: 'Aces' }),
            row({ memberId: 'm-05', wins: 8, pointsFor: 1100, maxPointsFor: 1300, pointsAgainst: 950, teamName: 'Bulls' }),
            row({ memberId: 'm-06', wins: 8, pointsFor: 1100, maxPointsFor: 1300, pointsAgainst: 950, teamName: 'Bulls' }),
            row({ memberId: 'm-07', wins: 5, pointsFor: 1000 }),
            row({ memberId: 'm-08', wins: 5, pointsFor: 1000 }),
            row({ memberId: 'm-09', wins: 5, pointsFor: 999 }),
            row({ memberId: 'm-10', wins: 2, teamName: 'Zephyrs' }),
            row({ memberId: 'm-11', wins: 2, teamName: 'Zephyrs' }),
            row({ memberId: 'm-12', wins: 2, teamName: 'Yaks' }),
        ]

        const rng = mulberry32(SEED)
        const expected = [...rows].sort(compareStandingsRows).map((r) => r.memberId)

        for (let i = 0; i < 50; i += 1) {
            const permuted = shuffled(rows, rng)
            const order = [...permuted].sort(compareStandingsRows).map((r) => r.memberId)
            expect(order).toEqual(expected)
        }
    })
})

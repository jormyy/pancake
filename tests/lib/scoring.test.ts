import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))
vi.mock('@/lib/shared/season', () => ({ getCurrentSeason: vi.fn(), getCurrentSeasonId: vi.fn(), getActiveSeasonId: vi.fn(), currentSeasonYear: vi.fn() }))
vi.mock('@/lib/shared/week', () => ({ getCurrentWeekNumber: vi.fn(), calculateWeekNumberFromDate: vi.fn() }))
vi.mock('@/lib/games', () => ({ getLivePlayerStats: vi.fn(), getTodaysGames: vi.fn() }))

import { computeLiveFantasyPoints } from '@/lib/scoring'
import type { LiveStatLine } from '@/lib/games'

const defaultSettings: Record<string, number> = {
    points: 1,
    rebounds: 1.25,
    assists: 1.5,
    steals: 3,
    blocks: 3,
    turnovers: -1,
    three_pointers_made: 0.5,
    field_goals_made: 0,
    field_goals_attempted: 0,
    free_throws_made: 0,
    free_throws_attempted: 0,
    double_double: 3,
    triple_double: 5,
}

function stat(overrides: Partial<LiveStatLine> = {}): LiveStatLine {
    return {
        points: 0,
        rebounds: 0,
        assists: 0,
        steals: 0,
        blocks: 0,
        turnovers: 0,
        threeMade: 0,
        fgMade: 0,
        fgAttempted: 0,
        ftMade: 0,
        ftAttempted: 0,
        doubleDouble: false,
        tripleDouble: false,
        didNotPlay: false,
        ...overrides,
    }
}

describe('computeLiveFantasyPoints', () => {
    it('returns 0 when didNotPlay is true', () => {
        const s = stat({ points: 30, rebounds: 10, didNotPlay: true })
        expect(computeLiveFantasyPoints(s, defaultSettings)).toBe(0)
    })

    it('scores points correctly', () => {
        const s = stat({ points: 20 })
        expect(computeLiveFantasyPoints(s, defaultSettings)).toBe(20)
    })

    it('scores rebounds at 1.25 each', () => {
        const s = stat({ rebounds: 8 })
        expect(computeLiveFantasyPoints(s, defaultSettings)).toBe(10)
    })

    it('scores assists at 1.5 each', () => {
        const s = stat({ assists: 6 })
        expect(computeLiveFantasyPoints(s, defaultSettings)).toBe(9)
    })

    it('scores steals at 3 each', () => {
        const s = stat({ steals: 2 })
        expect(computeLiveFantasyPoints(s, defaultSettings)).toBe(6)
    })

    it('scores blocks at 3 each', () => {
        const s = stat({ blocks: 3 })
        expect(computeLiveFantasyPoints(s, defaultSettings)).toBe(9)
    })

    it('turnovers are negative', () => {
        const s = stat({ turnovers: 4 })
        expect(computeLiveFantasyPoints(s, defaultSettings)).toBe(-4)
    })

    it('handles null turnovers as 0', () => {
        const s = stat({ turnovers: null as any })
        expect(computeLiveFantasyPoints(s, defaultSettings)).toBe(0)
    })

    it('scores three pointers at 0.5 bonus each', () => {
        const s = stat({ threeMade: 4 })
        expect(computeLiveFantasyPoints(s, defaultSettings)).toBe(2)
    })

    it('adds double double bonus', () => {
        const s = stat({ points: 10, rebounds: 10, doubleDouble: true })
        expect(computeLiveFantasyPoints(s, defaultSettings)).toBe(10 + 12.5 + 3)
    })

    it('adds triple double bonus', () => {
        const s = stat({ points: 10, rebounds: 10, assists: 10, tripleDouble: true })
        expect(computeLiveFantasyPoints(s, defaultSettings)).toBe(10 + 12.5 + 15 + 5)
    })

    it('double double and triple double bonuses stack', () => {
        const s = stat({ doubleDouble: true, tripleDouble: true })
        expect(computeLiveFantasyPoints(s, defaultSettings)).toBe(3 + 5)
    })

    it('returns 0 with all-zero settings', () => {
        const s = stat({ points: 30, rebounds: 15, assists: 10 })
        const zeroSettings = Object.fromEntries(Object.keys(defaultSettings).map((k) => [k, 0]))
        expect(computeLiveFantasyPoints(s, zeroSettings)).toBe(0)
    })

    it('handles missing settings keys by treating them as 0', () => {
        const s = stat({ points: 10, steals: 2 })
        expect(computeLiveFantasyPoints(s, {})).toBe(0)
    })

    it('combines all categories correctly', () => {
        const s = stat({
            points: 28,
            rebounds: 7,
            assists: 5,
            steals: 2,
            blocks: 1,
            turnovers: 3,
            threeMade: 4,
        })
        const expected = parseFloat((28 + 8.75 + 7.5 + 6 + 3 - 3 + 2).toFixed(2))
        expect(computeLiveFantasyPoints(s, defaultSettings)).toBe(expected)
    })

    it('scores FG made and attempted when configured', () => {
        const settings = { ...defaultSettings, field_goals_made: 2, field_goals_attempted: -0.5 }
        const s = stat({ fgMade: 10, fgAttempted: 20 })
        expect(computeLiveFantasyPoints(s, settings)).toBe(10)
    })

    it('scores free throws when configured', () => {
        const settings = { ...defaultSettings, free_throws_made: 1, free_throws_attempted: -0.5 }
        const s = stat({ ftMade: 8, ftAttempted: 10 })
        expect(computeLiveFantasyPoints(s, settings)).toBe(3)
    })
})

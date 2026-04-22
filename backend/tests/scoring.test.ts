import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/lib/supabase', () => ({ supabase: { from: vi.fn() } }))

import { calculateFantasyPoints } from '../src/lib/scoring'

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

function stat(overrides: Record<string, any> = {}) {
    return {
        points: 0,
        rebounds: 0,
        assists: 0,
        steals: 0,
        blocks: 0,
        turnovers: 0,
        three_pointers_made: 0,
        field_goals_made: 0,
        field_goals_attempted: 0,
        free_throws_made: 0,
        free_throws_attempted: 0,
        double_double: false,
        triple_double: false,
        did_not_play: false,
        ...overrides,
    }
}

describe('calculateFantasyPoints (backend)', () => {
    it('returns 0 when did_not_play is true', () => {
        expect(calculateFantasyPoints(stat({ points: 40, did_not_play: true }), defaultSettings)).toBe(0)
    })

    it('scores a standard stat line correctly', () => {
        const s = stat({ points: 25, rebounds: 8, assists: 5, steals: 1, blocks: 1, turnovers: 2 })
        // 25 + 10 + 7.5 + 3 + 3 - 2 = 46.5
        expect(calculateFantasyPoints(s, defaultSettings)).toBe(46.5)
    })

    it('adds double double bonus', () => {
        const s = stat({ points: 10, rebounds: 10, double_double: true })
        // 10 + 12.5 + 3 = 25.5
        expect(calculateFantasyPoints(s, defaultSettings)).toBe(25.5)
    })

    it('adds triple double bonus', () => {
        const s = stat({ points: 10, rebounds: 10, assists: 10, triple_double: true })
        // 10 + 12.5 + 15 + 5 = 42.5
        expect(calculateFantasyPoints(s, defaultSettings)).toBe(42.5)
    })

    it('handles null stats as 0 (no crash)', () => {
        const s = stat({ points: null, rebounds: null, turnovers: null })
        expect(() => calculateFantasyPoints(s, defaultSettings)).not.toThrow()
        expect(calculateFantasyPoints(s, defaultSettings)).toBe(0)
    })

    it('turnovers are negative', () => {
        expect(calculateFantasyPoints(stat({ turnovers: 5 }), defaultSettings)).toBe(-5)
    })

    it('scores three pointers at 0.5 bonus each', () => {
        expect(calculateFantasyPoints(stat({ three_pointers_made: 6 }), defaultSettings)).toBe(3)
    })

    it('returns 0 with all-zero settings', () => {
        const s = stat({ points: 50, rebounds: 20 })
        const zeroSettings = Object.fromEntries(Object.keys(defaultSettings).map((k) => [k, 0]))
        expect(calculateFantasyPoints(s, zeroSettings)).toBe(0)
    })

    it('scores FG stats when configured', () => {
        const settings = { ...defaultSettings, field_goals_made: 2, field_goals_attempted: -1 }
        const s = stat({ field_goals_made: 10, field_goals_attempted: 18 })
        // 10*2 + 18*(-1) = 20-18 = 2
        expect(calculateFantasyPoints(s, settings)).toBe(2)
    })

    it('scores free throw stats when configured', () => {
        const settings = { ...defaultSettings, free_throws_made: 1, free_throws_attempted: -0.5 }
        const s = stat({ free_throws_made: 8, free_throws_attempted: 10 })
        // 8*1 + 10*(-0.5) = 8-5 = 3
        expect(calculateFantasyPoints(s, settings)).toBe(3)
    })

    it('result is rounded to 2 decimal places', () => {
        const s = stat({ rebounds: 1 }) // 1 * 1.25 = 1.25
        const result = calculateFantasyPoints(s, defaultSettings)
        expect(result.toString()).not.toMatch(/\.\d{3,}/)
    })
})

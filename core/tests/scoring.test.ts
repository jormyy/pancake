import { describe, it, expect } from 'vitest'
import { calculateFantasyPoints } from '../src/scoring/formula'
import type { StatLine, ScoringSettings } from '../src/scoring/types'

const baseStats: StatLine = {
    points: 0,
    rebounds: 0,
    assists: 0,
    steals: 0,
    blocks: 0,
    turnovers: 0,
    threePointersMade: 0,
    fieldGoalsMade: 0,
    fieldGoalsAttempted: 0,
    freeThrowsMade: 0,
    freeThrowsAttempted: 0,
    doubleDouble: false,
    tripleDouble: false,
    didNotPlay: false,
}

const defaultSettings: ScoringSettings = {
    points: 1,
    rebounds: 1.2,
    assists: 1.5,
    steals: 3,
    blocks: 3,
    turnovers: -1,
    three_pointers_made: 1,
    field_goals_made: 1,
    field_goals_attempted: -1,
    free_throws_made: 1,
    free_throws_attempted: -1,
    double_double: 10,
    triple_double: 20,
}

describe('calculateFantasyPoints', () => {
    it('returns 0 for DNP', () => {
        const stats: StatLine = { ...baseStats, didNotPlay: true, points: 25 }
        expect(calculateFantasyPoints(stats, defaultSettings)).toBe(0)
    })

    it('returns 0 for all-zero stats', () => {
        expect(calculateFantasyPoints(baseStats, defaultSettings)).toBe(0)
    })

    it('calculates points correctly', () => {
        const stats: StatLine = { ...baseStats, points: 25 }
        expect(calculateFantasyPoints(stats, defaultSettings)).toBe(25)
    })

    it('calculates rebounds correctly', () => {
        const stats: StatLine = { ...baseStats, rebounds: 10 }
        expect(calculateFantasyPoints(stats, defaultSettings)).toBe(12)
    })

    it('calculates assists correctly', () => {
        const stats: StatLine = { ...baseStats, assists: 8 }
        expect(calculateFantasyPoints(stats, defaultSettings)).toBe(12)
    })

    it('calculates steals correctly', () => {
        const stats: StatLine = { ...baseStats, steals: 2 }
        expect(calculateFantasyPoints(stats, defaultSettings)).toBe(6)
    })

    it('calculates blocks correctly', () => {
        const stats: StatLine = { ...baseStats, blocks: 3 }
        expect(calculateFantasyPoints(stats, defaultSettings)).toBe(9)
    })

    it('calculates turnovers as negative', () => {
        const stats: StatLine = { ...baseStats, turnovers: 4 }
        expect(calculateFantasyPoints(stats, defaultSettings)).toBe(-4)
    })

    it('calculates three pointers correctly', () => {
        const stats: StatLine = { ...baseStats, threePointersMade: 3 }
        expect(calculateFantasyPoints(stats, defaultSettings)).toBe(3)
    })

    it('calculates field goal efficiency correctly', () => {
        const stats: StatLine = { ...baseStats, fieldGoalsMade: 8, fieldGoalsAttempted: 20 }
        // 8 * 1 + 20 * -1 = -12
        expect(calculateFantasyPoints(stats, defaultSettings)).toBe(-12)
    })

    it('calculates free throw efficiency correctly', () => {
        const stats: StatLine = { ...baseStats, freeThrowsMade: 5, freeThrowsAttempted: 6 }
        // 5 * 1 + 6 * -1 = -1
        expect(calculateFantasyPoints(stats, defaultSettings)).toBe(-1)
    })

    it('awards double-double bonus', () => {
        const stats: StatLine = { ...baseStats, doubleDouble: true }
        expect(calculateFantasyPoints(stats, defaultSettings)).toBe(10)
    })

    it('awards triple-double bonus', () => {
        const stats: StatLine = { ...baseStats, tripleDouble: true }
        expect(calculateFantasyPoints(stats, defaultSettings)).toBe(20)
    })

    it('doubleDouble + tripleDouble both apply', () => {
        const stats: StatLine = { ...baseStats, doubleDouble: true, tripleDouble: true }
        expect(calculateFantasyPoints(stats, defaultSettings)).toBe(30)
    })

    it('handles missing settings keys as zero', () => {
        const stats: StatLine = { ...baseStats, points: 25, steals: 2 }
        expect(calculateFantasyPoints(stats, {})).toBe(0)
    })

    it('handles partial settings', () => {
        const stats: StatLine = { ...baseStats, points: 25, steals: 2 }
        // points counts (1), steals don't (no key)
        expect(calculateFantasyPoints(stats, { points: 1 })).toBe(25)
    })

    it('handles a full stat line', () => {
        const stats: StatLine = {
            points: 30,
            rebounds: 12,
            assists: 10,
            steals: 2,
            blocks: 3,
            turnovers: 4,
            threePointersMade: 2,
            fieldGoalsMade: 12,
            fieldGoalsAttempted: 20,
            freeThrowsMade: 5,
            freeThrowsAttempted: 6,
            doubleDouble: true,
            tripleDouble: true,
            didNotPlay: false,
        }
        const expected = (
            30 * 1 +
            12 * 1.2 +
            10 * 1.5 +
            2 * 3 +
            3 * 3 +
            4 * (-1) +
            2 * 1 +
            12 * 1 +
            20 * (-1) +
            5 * 1 +
            6 * (-1) +
            10 +
            20
        ).toFixed(2)
        expect(calculateFantasyPoints(stats, defaultSettings)).toBe(parseFloat(expected))
    })

    it('rounds to 2 decimal places', () => {
        const stats: StatLine = { ...baseStats, points: 1.236 }
        const settings: ScoringSettings = { points: 1 }
        expect(calculateFantasyPoints(stats, settings)).toBe(1.24)
    })

    it('produces a number type', () => {
        const stats: StatLine = { ...baseStats, points: 25 }
        const result = calculateFantasyPoints(stats, defaultSettings)
        expect(typeof result).toBe('number')
    })
})

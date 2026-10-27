import { describe, it, expect } from 'vitest'
import { calculateFantasyPoints, roundFantasyPoints } from '@pancake/core'

describe('scoring parity — TS copies', () => {
    it('rounds fractional scoring weights to the same 2-decimal oracle', () => {
        expect(calculateFantasyPoints(
            {
                points: 1,
                rebounds: 1,
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
            },
            { points: 1 / 3, rebounds: 1 / 3 },
        )).toBe(0.67)
    })

    it('matches SQL half-away-from-zero rounding at cent ties', () => {
        expect(roundFantasyPoints(1.005)).toBe(1.01)
        expect(roundFantasyPoints(2.675)).toBe(2.68)
        expect(roundFantasyPoints(10.075)).toBe(10.08)
        expect(roundFantasyPoints(-1.005)).toBe(-1.01)
        expect(roundFantasyPoints(-2.675)).toBe(-2.68)
        expect(roundFantasyPoints(-10.075)).toBe(-10.08)
    })
})

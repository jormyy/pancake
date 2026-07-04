import { describe, it, expect } from 'vitest'
import { calculateFantasyPoints } from '../src/scoring/formula'
import type { StatLine, ScoringSettings } from '../src/scoring/types'

// Deterministic property battery: seed is recorded so every run replays the
// same randomized cases.
const SEED = 0x5eed2026

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

function randInt(rng: () => number, max: number): number {
    return Math.floor(rng() * (max + 1))
}

const zeroLine: StatLine = {
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

type NumericStat = Exclude<keyof StatLine, 'doubleDouble' | 'tripleDouble' | 'didNotPlay'>

const numericStats: NumericStat[] = [
    'points',
    'rebounds',
    'assists',
    'steals',
    'blocks',
    'turnovers',
    'threePointersMade',
    'fieldGoalsMade',
    'fieldGoalsAttempted',
    'freeThrowsMade',
    'freeThrowsAttempted',
]

const settingKeyByStat: Record<NumericStat, string> = {
    points: 'points',
    rebounds: 'rebounds',
    assists: 'assists',
    steals: 'steals',
    blocks: 'blocks',
    turnovers: 'turnovers',
    threePointersMade: 'three_pointers_made',
    fieldGoalsMade: 'field_goals_made',
    fieldGoalsAttempted: 'field_goals_attempted',
    freeThrowsMade: 'free_throws_made',
    freeThrowsAttempted: 'free_throws_attempted',
}

const bonusSettingKeys = ['double_double', 'triple_double'] as const

function randLine(rng: () => number): StatLine {
    const line = { ...zeroLine }
    for (const stat of numericStats) line[stat] = randInt(rng, 30)
    line.doubleDouble = rng() < 0.3
    line.tripleDouble = rng() < 0.15
    return line
}

// Quarter-step weights (-3..3 in 0.25 increments) are exactly representable in
// binary floating point, so integer stat lines score with zero rounding error
// and additivity must hold EXACTLY.
function dyadicSettings(rng: () => number): ScoringSettings {
    const settings: ScoringSettings = {}
    for (const stat of numericStats) settings[settingKeyByStat[stat]] = (randInt(rng, 24) - 12) * 0.25
    for (const key of bonusSettingKeys) settings[key] = randInt(rng, 40) * 0.5
    return settings
}

// Tenth-step weights (like the real default 1.2) are NOT exactly representable,
// so rounding is exercised and additivity only holds within round-off.
function tenthSettings(rng: () => number): ScoringSettings {
    const settings: ScoringSettings = {}
    for (const stat of numericStats) settings[settingKeyByStat[stat]] = (randInt(rng, 60) - 30) / 10
    for (const key of bonusSettingKeys) settings[key] = randInt(rng, 200) / 10
    return settings
}

function addLines(a: StatLine, b: StatLine): StatLine {
    const sum = { ...zeroLine }
    for (const stat of numericStats) sum[stat] = a[stat] + b[stat]
    return sum
}

describe('calculateFantasyPoints properties', () => {
    it(`DNP scores 0 regardless of the stat line (seed ${SEED.toString(16)}, 500 cases)`, () => {
        const rng = mulberry32(SEED)
        for (let i = 0; i < 500; i += 1) {
            const line = { ...randLine(rng), didNotPlay: true }
            const settings = i % 2 === 0 ? dyadicSettings(rng) : tenthSettings(rng)
            expect(calculateFantasyPoints(line, settings)).toBe(0)
        }
    })

    it('an all-zero stat line scores 0 for any settings (100 cases)', () => {
        const rng = mulberry32(SEED + 1)
        for (let i = 0; i < 100; i += 1) {
            const settings = i % 2 === 0 ? dyadicSettings(rng) : tenthSettings(rng)
            expect(calculateFantasyPoints(zeroLine, settings)).toBe(0)
        }
    })

    it('is exactly additive when the unrounded accumulation is exact (dyadic weights, 200 cases)', () => {
        const rng = mulberry32(SEED + 2)
        for (let i = 0; i < 200; i += 1) {
            const settings = dyadicSettings(rng)
            const a = { ...randLine(rng), doubleDouble: false, tripleDouble: false }
            const b = { ...randLine(rng), doubleDouble: false, tripleDouble: false }
            expect(calculateFantasyPoints(addLines(a, b), settings))
                .toBe(calculateFantasyPoints(a, settings) + calculateFantasyPoints(b, settings))
        }
    })

    it('decomposes into per-category contributions (dyadic weights, 200 cases)', () => {
        const rng = mulberry32(SEED + 3)
        for (let i = 0; i < 200; i += 1) {
            const settings = dyadicSettings(rng)
            const line = randLine(rng)

            let categorySum = 0
            for (const stat of numericStats) {
                categorySum += calculateFantasyPoints({ ...zeroLine, [stat]: line[stat] }, settings)
            }
            categorySum += calculateFantasyPoints({ ...zeroLine, doubleDouble: line.doubleDouble }, settings)
            categorySum += calculateFantasyPoints({ ...zeroLine, tripleDouble: line.tripleDouble }, settings)

            expect(calculateFantasyPoints(line, settings)).toBe(categorySum)
        }
    })

    it('is additive within rounding tolerance for non-dyadic weights (200 cases)', () => {
        const rng = mulberry32(SEED + 4)
        for (let i = 0; i < 200; i += 1) {
            const settings = tenthSettings(rng)
            const a = { ...randLine(rng), doubleDouble: false, tripleDouble: false }
            const b = { ...randLine(rng), doubleDouble: false, tripleDouble: false }
            const combined = calculateFantasyPoints(addLines(a, b), settings)
            const split = calculateFantasyPoints(a, settings) + calculateFantasyPoints(b, settings)
            // One rounding on the combined line vs two on the split lines:
            // at most 0.005 + 2 * 0.005 of round-off.
            expect(Math.abs(combined - split)).toBeLessThanOrEqual(0.02)
        }
    })

    it('is monotone in every stat according to its weight sign (100 cases per stat)', () => {
        const rng = mulberry32(SEED + 5)
        for (const stat of numericStats) {
            for (let i = 0; i < 100; i += 1) {
                const settings = dyadicSettings(rng)
                const line = randLine(rng)
                const bumped = { ...line, [stat]: line[stat] + 1 + randInt(rng, 9) }

                const before = calculateFantasyPoints(line, settings)
                const after = calculateFantasyPoints(bumped, settings)
                const weight = settings[settingKeyByStat[stat]]

                if (weight > 0) expect(after).toBeGreaterThanOrEqual(before)
                else if (weight < 0) expect(after).toBeLessThanOrEqual(before)
                else expect(after).toBe(before)
            }
        }
    })

    it('never rewards turnovers under the conventional negative weight', () => {
        const rng = mulberry32(SEED + 6)
        const settings: ScoringSettings = {
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
        for (let i = 0; i < 100; i += 1) {
            const line = randLine(rng)
            const bumped = { ...line, turnovers: line.turnovers + 1 + randInt(rng, 5) }
            expect(calculateFantasyPoints(bumped, settings)).toBeLessThan(calculateFantasyPoints(line, settings))
        }
    })
})

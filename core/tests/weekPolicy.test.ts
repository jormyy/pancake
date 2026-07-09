import { describe, expect, it } from 'vitest'
import { resolveSeasonWeekNumber, type SeasonWeekRange } from '../src/season/weekPolicy'

const weeks: SeasonWeekRange[] = [
    { week_number: 1, week_start: '2025-10-21', week_end: '2025-10-26' },
    { week_number: 2, week_start: '2025-10-27', week_end: '2025-11-02' },
    { week_number: 4, week_start: '2025-11-10', week_end: '2025-11-16' },
]

describe('resolveSeasonWeekNumber', () => {
    it('returns only containing weeks in exact mode', () => {
        expect(resolveSeasonWeekNumber(weeks, '2025-10-24', 'exact')).toBe(1)
        expect(resolveSeasonWeekNumber(weeks, '2025-11-06', 'exact')).toBeNull()
        expect(resolveSeasonWeekNumber(weeks, '2026-05-01', 'exact')).toBeNull()
    })

    it('uses current-or-next for app reads before season and in seeded gaps', () => {
        expect(resolveSeasonWeekNumber(weeks, '2025-10-01', 'current-or-next')).toBe(1)
        expect(resolveSeasonWeekNumber(weeks, '2025-11-06', 'current-or-next')).toBe(4)
    })

    it('clamps current-or-next to the final seeded week after season end', () => {
        expect(resolveSeasonWeekNumber(weeks, '2026-05-01', 'current-or-next')).toBe(4)
    })

    it('uses current-or-previous for scoring and never starts before week 1', () => {
        expect(resolveSeasonWeekNumber(weeks, '2025-10-01', 'current-or-previous')).toBeNull()
        expect(resolveSeasonWeekNumber(weeks, '2025-11-06', 'current-or-previous')).toBe(2)
        expect(resolveSeasonWeekNumber(weeks, '2026-05-01', 'current-or-previous')).toBe(4)
    })
})

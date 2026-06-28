import { describe, it, expect } from 'vitest'
import { calculateWeekNumberFromDate } from '../src/season/week'

describe('calculateWeekNumberFromDate', () => {
    const week1Start = '2025-10-22'
    const week1End = '2025-10-26'

    it('returns 1 for the first day of week 1', () => {
        expect(calculateWeekNumberFromDate('2025-10-22', week1Start, week1End)).toBe(1)
    })

    it('returns 1 for the last day of week 1', () => {
        expect(calculateWeekNumberFromDate('2025-10-26', week1Start, week1End)).toBe(1)
    })

    it('returns 1 for a day within week 1', () => {
        expect(calculateWeekNumberFromDate('2025-10-24', week1Start, week1End)).toBe(1)
    })

    it('returns 2 for the first day after week 1', () => {
        expect(calculateWeekNumberFromDate('2025-10-27', week1Start, week1End)).toBe(2)
    })

    it('returns 2 for the last day of week 2', () => {
        expect(calculateWeekNumberFromDate('2025-11-02', week1Start, week1End)).toBe(2)
    })

    it('returns 3 for week 3', () => {
        expect(calculateWeekNumberFromDate('2025-11-03', week1Start, week1End)).toBe(3)
    })

    it('returns 1 for a date before week 1', () => {
        expect(calculateWeekNumberFromDate('2025-10-01', week1Start, week1End)).toBe(1)
    })

    it('handles a later week in the season', () => {
        // Week 2 starts Oct 27, each subsequent week is 7 days
        // Mar 9 = week 21 (133 days after Oct 27 → floor(133/7) = 19 + 2 = 21)
        expect(calculateWeekNumberFromDate('2026-03-09', week1Start, week1End)).toBe(21)
    })

    it('uses calendar-day arithmetic across DST changes', () => {
        expect(calculateWeekNumberFromDate('2025-11-02', week1Start, week1End)).toBe(2)
        expect(calculateWeekNumberFromDate('2026-03-08', week1Start, week1End)).toBe(20)
        expect(calculateWeekNumberFromDate('2026-03-09', week1Start, week1End)).toBe(21)
    })
})

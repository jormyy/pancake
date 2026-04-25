import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))
vi.mock('@/lib/shared/dates', () => ({ todayDateString: vi.fn().mockReturnValue('2026-04-22') }))

import { calculateWeekNumberFromDate } from '@/lib/shared/week'

const WEEK1_START = '2025-10-21'
const WEEK1_END = '2025-10-26'

describe('calculateWeekNumberFromDate', () => {
    describe('Week 1 (Oct 21–26, 2025)', () => {
        it('Oct 21 is week 1 (first day)', () => {
            expect(calculateWeekNumberFromDate('2025-10-21', WEEK1_START, WEEK1_END)).toBe(1)
        })
        it('Oct 24 is week 1 (midweek)', () => {
            expect(calculateWeekNumberFromDate('2025-10-24', WEEK1_START, WEEK1_END)).toBe(1)
        })
        it('Oct 26 is week 1 (last day)', () => {
            expect(calculateWeekNumberFromDate('2025-10-26', WEEK1_START, WEEK1_END)).toBe(1)
        })
    })

    describe('Week 2 (Oct 27 – Nov 2, 2025)', () => {
        it('Oct 27 is week 2 (first day)', () => {
            expect(calculateWeekNumberFromDate('2025-10-27', WEEK1_START, WEEK1_END)).toBe(2)
        })
        it('Nov 2 is week 2 (last day)', () => {
            expect(calculateWeekNumberFromDate('2025-11-02', WEEK1_START, WEEK1_END)).toBe(2)
        })
    })

    describe('Week 3 (Nov 3 – Nov 9, 2025)', () => {
        it('Nov 3 is week 3 (first day)', () => {
            expect(calculateWeekNumberFromDate('2025-11-03', WEEK1_START, WEEK1_END)).toBe(3)
        })
        it('Nov 9 is week 3 (last day)', () => {
            expect(calculateWeekNumberFromDate('2025-11-09', WEEK1_START, WEEK1_END)).toBe(3)
        })
    })

    it('weeks increment by 7 days from Oct 27', () => {
        expect(calculateWeekNumberFromDate('2025-11-10', WEEK1_START, WEEK1_END)).toBe(4)
        expect(calculateWeekNumberFromDate('2025-11-17', WEEK1_START, WEEK1_END)).toBe(5)
        expect(calculateWeekNumberFromDate('2025-12-22', WEEK1_START, WEEK1_END)).toBe(10)
    })

    it('clamps to week 1 for dates before the season', () => {
        expect(calculateWeekNumberFromDate('2025-10-20', WEEK1_START, WEEK1_END)).toBe(1)
    })

    it('calculates a late-season week correctly (Apr 12, 2026 = week 25)', () => {
        expect(calculateWeekNumberFromDate('2026-04-12', WEEK1_START, WEEK1_END)).toBe(25)
    })
})

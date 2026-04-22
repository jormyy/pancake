import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))
vi.mock('@/lib/shared/dates', () => ({ todayDateString: vi.fn().mockReturnValue('2026-04-22') }))

import { calculateWeekNumberFromDate } from '@/lib/shared/week'

describe('calculateWeekNumberFromDate', () => {
    describe('Week 1 (Oct 21–26, 2025)', () => {
        it('Oct 21 is week 1 (first day)', () => {
            expect(calculateWeekNumberFromDate('2025-10-21')).toBe(1)
        })
        it('Oct 24 is week 1 (midweek)', () => {
            expect(calculateWeekNumberFromDate('2025-10-24')).toBe(1)
        })
        it('Oct 26 is week 1 (last day)', () => {
            expect(calculateWeekNumberFromDate('2025-10-26')).toBe(1)
        })
    })

    describe('Week 2 (Oct 27 – Nov 2, 2025)', () => {
        it('Oct 27 is week 2 (first day)', () => {
            expect(calculateWeekNumberFromDate('2025-10-27')).toBe(2)
        })
        it('Nov 2 is week 2 (last day)', () => {
            expect(calculateWeekNumberFromDate('2025-11-02')).toBe(2)
        })
    })

    describe('Week 3 (Nov 3 – Nov 9, 2025)', () => {
        it('Nov 3 is week 3 (first day)', () => {
            expect(calculateWeekNumberFromDate('2025-11-03')).toBe(3)
        })
        it('Nov 9 is week 3 (last day)', () => {
            expect(calculateWeekNumberFromDate('2025-11-09')).toBe(3)
        })
    })

    it('weeks increment by 7 days from Oct 27', () => {
        // Week 4 starts Nov 10
        expect(calculateWeekNumberFromDate('2025-11-10')).toBe(4)
        // Week 5 starts Nov 17
        expect(calculateWeekNumberFromDate('2025-11-17')).toBe(5)
        // Week 10 starts Dec 22
        expect(calculateWeekNumberFromDate('2025-12-22')).toBe(10)
    })

    it('clamps to week 1 for dates before the season', () => {
        // Oct 20 is before season start — falls before week2Start, returns max(1, negative) = 1
        expect(calculateWeekNumberFromDate('2025-10-20')).toBe(1)
    })

    it('calculates a late-season week correctly (Apr 12, 2026 = week 25)', () => {
        // Days from Oct 27 to Apr 12: 167 days → floor(167/7) = 23 → week 23+2 = 25
        expect(calculateWeekNumberFromDate('2026-04-12')).toBe(25)
    })
})

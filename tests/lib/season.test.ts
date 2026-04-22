import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))

import { currentSeasonYear } from '@/lib/shared/season'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('currentSeasonYear', () => {
    // getMonth() is 0-indexed: Oct = 9, Nov = 10, Dec = 11

    // Use Date(year, month, day) to construct in LOCAL time and avoid UTC-offset edge cases.
    // getMonth() is 0-indexed: Jan=0, Sep=8, Oct=9, Nov=10, Dec=11

    it('returns next year in October (season start)', () => {
        vi.setSystemTime(new Date(2025, 9, 15))
        expect(currentSeasonYear()).toBe(2026)
    })

    it('returns next year in November', () => {
        vi.setSystemTime(new Date(2025, 10, 1))
        expect(currentSeasonYear()).toBe(2026)
    })

    it('returns next year in December', () => {
        vi.setSystemTime(new Date(2025, 11, 31))
        expect(currentSeasonYear()).toBe(2026)
    })

    it('returns current year in January (mid-season)', () => {
        vi.setSystemTime(new Date(2026, 0, 15))
        expect(currentSeasonYear()).toBe(2026)
    })

    it('returns current year in April (playoff stretch)', () => {
        vi.setSystemTime(new Date(2026, 3, 12))
        expect(currentSeasonYear()).toBe(2026)
    })

    it('returns current year in September (offseason — month=8, not >= 9)', () => {
        vi.setSystemTime(new Date(2026, 8, 1))
        expect(currentSeasonYear()).toBe(2026)
    })

    it('returns next year when next season begins in October', () => {
        vi.setSystemTime(new Date(2026, 9, 1))
        expect(currentSeasonYear()).toBe(2027)
    })
})

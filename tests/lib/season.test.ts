import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))

import { currentSeasonYear } from '@/lib/shared/season'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('currentSeasonYear', () => {
    it('returns next year in October (season start)', () => {
        vi.setSystemTime(new Date('2025-10-15T12:00:00Z'))
        expect(currentSeasonYear()).toBe(2026)
    })

    it('returns next year in November', () => {
        vi.setSystemTime(new Date('2025-11-01T12:00:00Z'))
        expect(currentSeasonYear()).toBe(2026)
    })

    it('returns next year in December', () => {
        vi.setSystemTime(new Date('2025-12-31T12:00:00Z'))
        expect(currentSeasonYear()).toBe(2026)
    })

    it('returns current year in January (mid-season)', () => {
        vi.setSystemTime(new Date('2026-01-15T12:00:00Z'))
        expect(currentSeasonYear()).toBe(2026)
    })

    it('returns current year in April (playoff stretch)', () => {
        vi.setSystemTime(new Date('2026-04-12T12:00:00Z'))
        expect(currentSeasonYear()).toBe(2026)
    })

    it('returns current year in September (offseason — month=8, not >= 9)', () => {
        vi.setSystemTime(new Date('2026-09-01T12:00:00Z'))
        expect(currentSeasonYear()).toBe(2026)
    })

    it('uses ET rather than host-local or UTC at the Oct 1 boundary', () => {
        vi.setSystemTime(new Date('2026-10-01T00:30:00Z'))
        expect(currentSeasonYear()).toBe(2026)

        vi.setSystemTime(new Date('2026-10-01T04:30:00Z'))
        expect(currentSeasonYear()).toBe(2027)
    })
})

import { describe, it, expect, vi } from 'vitest'
import { currentSeasonYear } from '../src/season/year'

describe('currentSeasonYear', () => {
    it('returns current year for Jan', () => {
        vi.setSystemTime(new Date('2026-01-15T12:00:00Z'))
        expect(currentSeasonYear()).toBe(2026)
    })

    it('returns current year for Sep', () => {
        vi.setSystemTime(new Date('2026-09-30T12:00:00Z'))
        expect(currentSeasonYear()).toBe(2026)
    })

    it('returns next year for Oct', () => {
        vi.setSystemTime(new Date('2025-10-01T12:00:00Z'))
        expect(currentSeasonYear()).toBe(2026)
    })

    it('returns next year for Dec', () => {
        vi.setSystemTime(new Date('2025-12-31T12:00:00Z'))
        expect(currentSeasonYear()).toBe(2026)
    })

    it('returns next year for November', () => {
        vi.setSystemTime(new Date('2024-11-15T12:00:00Z'))
        expect(currentSeasonYear()).toBe(2025)
    })
})

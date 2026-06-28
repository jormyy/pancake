import { describe, it, expect } from 'vitest'
import { endOfETDayUTC, todayDateString, todayET } from '../src/dates'

describe('todayDateString', () => {
    it('returns a string in YYYY-MM-DD format', () => {
        const result = todayDateString()
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('returns valid date components', () => {
        const [y, m, d] = todayDateString().split('-').map(Number)
        expect(y).toBeGreaterThanOrEqual(2024)
        expect(m).toBeGreaterThanOrEqual(1)
        expect(m).toBeLessThanOrEqual(12)
        expect(d).toBeGreaterThanOrEqual(1)
        expect(d).toBeLessThanOrEqual(31)
    })
})

describe('todayET', () => {
    it('returns a string in YYYY-MM-DD format', () => {
        const result = todayET()
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('returns valid date components', () => {
        const [y, m, d] = todayET().split('-').map(Number)
        expect(y).toBeGreaterThanOrEqual(2024)
        expect(m).toBeGreaterThanOrEqual(1)
        expect(m).toBeLessThanOrEqual(12)
        expect(d).toBeGreaterThanOrEqual(1)
        expect(d).toBeLessThanOrEqual(31)
    })
})

describe('endOfETDayUTC', () => {
    it('returns next ET midnight in UTC for EST and EDT dates', () => {
        expect(endOfETDayUTC('2026-01-15')).toBe('2026-01-16T05:00:00.000Z')
        expect(endOfETDayUTC('2026-07-15')).toBe('2026-07-16T04:00:00.000Z')
    })

    it('handles DST transition dates using the offset at next local midnight', () => {
        expect(endOfETDayUTC('2026-03-08')).toBe('2026-03-09T04:00:00.000Z')
        expect(endOfETDayUTC('2026-11-01')).toBe('2026-11-02T05:00:00.000Z')
    })
})

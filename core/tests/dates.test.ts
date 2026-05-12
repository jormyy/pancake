import { describe, it, expect } from 'vitest'
import { todayDateString, todayET } from '../src/dates'

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

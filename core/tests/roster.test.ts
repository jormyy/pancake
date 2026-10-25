import { describe, it, expect } from 'vitest'
import { isIREligible, isDTD, isTaxiEligible } from '../src/roster/eligibility'

describe('isIREligible', () => {
    it('returns false for null', () => {
        expect(isIREligible(null)).toBe(false)
    })

    it('returns false for empty string', () => {
        expect(isIREligible('')).toBe(false)
    })

    it('returns true for Out', () => {
        expect(isIREligible('Out')).toBe(true)
        expect(isIREligible('out')).toBe(true)
        expect(isIREligible('OUT')).toBe(true)
    })

    it('returns true for IR', () => {
        expect(isIREligible('IR')).toBe(true)
        expect(isIREligible('ir')).toBe(true)
    })

    it('returns true for IR-full or IR-LTR', () => {
        expect(isIREligible('IR-full')).toBe(true)
        expect(isIREligible('ir-ltr')).toBe(true)
    })

    it('returns false for DTD', () => {
        expect(isIREligible('DTD')).toBe(false)
        expect(isIREligible('dtd')).toBe(false)
    })

    it('returns false for healthy', () => {
        expect(isIREligible('Healthy')).toBe(false)
    })
})

describe('isDTD', () => {
    it('returns false for null', () => {
        expect(isDTD(null)).toBe(false)
    })

    it('returns true for DTD', () => {
        expect(isDTD('DTD')).toBe(true)
        expect(isDTD('dtd')).toBe(true)
    })

    it('returns false for Out', () => {
        expect(isDTD('Out')).toBe(false)
    })

    it('returns false for IR', () => {
        expect(isDTD('IR')).toBe(false)
    })
})

describe('isTaxiEligible', () => {
    it.each([[0, null, true], [0, 90, true], [1, 64, true], [2, 65, false], [null, 0, true], [null, null, false], [1, null, false]])('uses experience %s and games %s', (years, games, eligible) => {
        expect(isTaxiEligible(years, games)).toBe(eligible)
    })
})

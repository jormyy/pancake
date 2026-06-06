import { describe, it, expect } from 'vitest'
import { isIREligible, isDTD, isTaxiEligible } from '../src/roster/eligibility'
import { isRosterFull, hasTaxiSpace } from '../src/roster/limits'

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
    it('returns false for null', () => {
        expect(isTaxiEligible(null, 0)).toBe(false)
        expect(isTaxiEligible(1, 1)).toBe(false)
        expect(isTaxiEligible(1, null)).toBe(false)
    })

    it('returns true for a current rookie draft number', () => {
        expect(isTaxiEligible(1, 0)).toBe(true)
        expect(isTaxiEligible(30, 0)).toBe(true)
        expect(isTaxiEligible(0, 0)).toBe(true)
    })
})

describe('isRosterFull', () => {
    it('returns false when under limit', () => {
        expect(isRosterFull(10, 20)).toBe(false)
    })

    it('returns true when at limit', () => {
        expect(isRosterFull(20, 20)).toBe(true)
    })

    it('returns true when over limit', () => {
        expect(isRosterFull(21, 20)).toBe(true)
    })
})

describe('hasTaxiSpace', () => {
    it('returns true when under limit', () => {
        expect(hasTaxiSpace(0, 2)).toBe(true)
    })

    it('returns false when at limit', () => {
        expect(hasTaxiSpace(2, 2)).toBe(false)
    })

    it('returns false when over limit', () => {
        expect(hasTaxiSpace(3, 2)).toBe(false)
    })
})

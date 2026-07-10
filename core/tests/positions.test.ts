import { describe, it, expect } from 'vitest'
import { canOccupyRosterSlot, canPlayLineupSlot } from '../src/positions'

describe('canPlayLineupSlot', () => {
    it('allows PG in PG slot', () => {
        expect(canPlayLineupSlot('PG', [], 'PG')).toBe(true)
    })

    it('allows SG in SG slot', () => {
        expect(canPlayLineupSlot('SG', [], 'SG')).toBe(true)
    })

    it('allows PG in G slot', () => {
        expect(canPlayLineupSlot('PG', [], 'G')).toBe(true)
    })

    it('allows SG in G slot', () => {
        expect(canPlayLineupSlot('SG', [], 'G')).toBe(true)
    })

    it('denies C in G slot', () => {
        expect(canPlayLineupSlot('C', [], 'G')).toBe(false)
    })

    it('allows SF in F slot', () => {
        expect(canPlayLineupSlot('SF', [], 'F')).toBe(true)
    })

    it('allows PF in F slot', () => {
        expect(canPlayLineupSlot('PF', [], 'F')).toBe(true)
    })

    it('denies PG in F slot', () => {
        expect(canPlayLineupSlot('PG', [], 'F')).toBe(false)
    })

    it('allows any position in UTIL slot', () => {
        expect(canPlayLineupSlot('PG', [], 'UTIL')).toBe(true)
        expect(canPlayLineupSlot('C', [], 'UTIL')).toBe(true)
    })

    it('allows any position in BE slot', () => {
        expect(canPlayLineupSlot('PG', [], 'BE')).toBe(true)
    })

    it('does not treat IR as a playable lineup slot', () => {
        expect(canPlayLineupSlot('PG', [], 'IR')).toBe(false)
    })

    it('returns false for arbitrary and inherited property names', () => {
        expect(canPlayLineupSlot('PG', [], 'unknown')).toBe(false)
        expect(canPlayLineupSlot('PG', [], 'constructor')).toBe(false)
        expect(canPlayLineupSlot('PG', [], 'toString')).toBe(false)
    })

    it('uses eligiblePositions when available', () => {
        expect(canPlayLineupSlot('C', ['PG', 'SG'], 'PG')).toBe(true)
        expect(canPlayLineupSlot('PG', ['SF', 'PF'], 'F')).toBe(true)
    })

    it('eligiblePositions takes priority over position', () => {
        expect(canPlayLineupSlot('PG', ['C'], 'C')).toBe(true)
    })

    it('returns false for null position with no eligible positions', () => {
        expect(canPlayLineupSlot(null, [], 'PG')).toBe(false)
    })

    it('UTIL and BE still require a known eligible position', () => {
        expect(canPlayLineupSlot(null, [], 'UTIL')).toBe(false)
        expect(canPlayLineupSlot(null, [], 'BE')).toBe(false)
        expect(canPlayLineupSlot(null, [], 'PG')).toBe(false)
    })

    it('position group G accepts both PG and SG', () => {
        expect(canPlayLineupSlot('PG', [], 'G')).toBe(true)
        expect(canPlayLineupSlot('SG', [], 'G')).toBe(true)
        expect(canPlayLineupSlot('SF', [], 'G')).toBe(false)
    })

    it('position group F accepts both SF and PF', () => {
        expect(canPlayLineupSlot('SF', [], 'F')).toBe(true)
        expect(canPlayLineupSlot('PF', [], 'F')).toBe(true)
        expect(canPlayLineupSlot('SG', [], 'F')).toBe(false)
    })
})

describe('canOccupyRosterSlot', () => {
    it('keeps inactive IR roster semantics separate from lineup slots', () => {
        expect(canOccupyRosterSlot(null, [], 'IR')).toBe(true)
        expect(canOccupyRosterSlot(null, [], 'UTIL')).toBe(false)
    })
})

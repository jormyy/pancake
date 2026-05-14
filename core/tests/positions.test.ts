import { describe, it, expect } from 'vitest'
import { canPlaySlot } from '../src/positions'
import type { SlotType } from '../src/positions'

describe('canPlaySlot', () => {
    it('allows PG in PG slot', () => {
        expect(canPlaySlot('PG', [], 'PG')).toBe(true)
    })

    it('allows SG in SG slot', () => {
        expect(canPlaySlot('SG', [], 'SG')).toBe(true)
    })

    it('allows PG in G slot', () => {
        expect(canPlaySlot('PG', [], 'G')).toBe(true)
    })

    it('allows SG in G slot', () => {
        expect(canPlaySlot('SG', [], 'G')).toBe(true)
    })

    it('denies C in G slot', () => {
        expect(canPlaySlot('C', [], 'G')).toBe(false)
    })

    it('allows SF in F slot', () => {
        expect(canPlaySlot('SF', [], 'F')).toBe(true)
    })

    it('allows PF in F slot', () => {
        expect(canPlaySlot('PF', [], 'F')).toBe(true)
    })

    it('denies PG in F slot', () => {
        expect(canPlaySlot('PG', [], 'F')).toBe(false)
    })

    it('allows any position in UTIL slot', () => {
        expect(canPlaySlot('PG', [], 'UTIL')).toBe(true)
        expect(canPlaySlot('C', [], 'UTIL')).toBe(true)
    })

    it('allows any position in BE slot', () => {
        expect(canPlaySlot('PG', [], 'BE')).toBe(true)
    })

    it('allows any position in IR slot', () => {
        expect(canPlaySlot('PG', [], 'IR')).toBe(true)
    })

    it('uses eligiblePositions when available', () => {
        expect(canPlaySlot('C', ['PG', 'SG'], 'PG')).toBe(true)
        expect(canPlaySlot('PG', ['SF', 'PF'], 'F')).toBe(true)
    })

    it('eligiblePositions takes priority over position', () => {
        expect(canPlaySlot('PG', ['C'], 'C')).toBe(true)
    })

    it('returns false for null position with no eligible positions', () => {
        expect(canPlaySlot(null, [], 'PG')).toBe(false)
    })

    it('UTIL/BE/IR slots work even with null position and empty eligible positions', () => {
        expect(canPlaySlot(null, [], 'UTIL')).toBe(true)
        expect(canPlaySlot(null, [], 'BE')).toBe(true)
        expect(canPlaySlot(null, [], 'IR')).toBe(true)
        expect(canPlaySlot(null, [], 'PG')).toBe(false)
    })

    it('position group G accepts both PG and SG', () => {
        expect(canPlaySlot('PG', [], 'G')).toBe(true)
        expect(canPlaySlot('SG', [], 'G')).toBe(true)
        expect(canPlaySlot('SF', [], 'G')).toBe(false)
    })

    it('position group F accepts both SF and PF', () => {
        expect(canPlaySlot('SF', [], 'F')).toBe(true)
        expect(canPlaySlot('PF', [], 'F')).toBe(true)
        expect(canPlaySlot('SG', [], 'F')).toBe(false)
    })
})

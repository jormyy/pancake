import { describe, expect, it, vi } from 'vitest'
import {
    playerEligiblePositions,
    playerSeasonContextText,
} from '@/lib/player-context'

vi.mock('@/lib/format', () => ({
    formatPoints: (value: number | null | undefined) => value == null ? '-' : value.toFixed(1),
}))

describe('player context helpers', () => {
    it('prefers eligible positions and falls back to the primary position', () => {
        expect(playerEligiblePositions({ position: 'G', eligiblePositions: ['PG', 'SG'] })).toEqual(['PG', 'SG'])
        expect(playerEligiblePositions({ position: 'C', eligiblePositions: [] })).toEqual(['C'])
        expect(playerEligiblePositions({ position: null, eligiblePositions: null })).toEqual([])
    })

    it('combines fantasy points and minutes without veteran year labels', () => {
        expect(playerSeasonContextText({
            avgFantasyPoints: 42.345,
            avgMinutesPlayed: 31,
            yearsExp: 3,
        })).toBe('42.3 FP · 31.0 MIN')
    })

    it('keeps partial and empty stats readable', () => {
        expect(playerSeasonContextText({ avgFantasyPoints: 0, avgMinutesPlayed: null, yearsExp: 0 })).toBe('0.0 FP')
        expect(playerSeasonContextText({ avgFantasyPoints: null, avgMinutesPlayed: null, yearsExp: null })).toBe('No season stats')
    })
})

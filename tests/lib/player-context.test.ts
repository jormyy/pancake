import { describe, expect, it, vi } from 'vitest'
import {
    playerEligiblePositions,
    playerSeasonContextText,
    playerYearsExperienceLabel,
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

    it('formats experience labels without hiding rookies', () => {
        expect(playerYearsExperienceLabel(null)).toBeNull()
        expect(playerYearsExperienceLabel(0)).toBe('Rookie')
        expect(playerYearsExperienceLabel(1)).toBe('Yr 2')
        expect(playerYearsExperienceLabel(8)).toBe('Yr 9')
    })

    it('combines fantasy points, minutes, and experience in a compact stat line', () => {
        expect(playerSeasonContextText({
            avgFantasyPoints: 42.345,
            avgMinutesPlayed: 31,
            yearsExp: 3,
        })).toBe('42.3 FPts · 31.0 MIN · Yr 4')
    })

    it('keeps partial and empty stats readable', () => {
        expect(playerSeasonContextText({ avgFantasyPoints: 0, avgMinutesPlayed: null, yearsExp: 0 })).toBe('0.0 FPts · Rookie')
        expect(playerSeasonContextText({ avgFantasyPoints: null, avgMinutesPlayed: null, yearsExp: null })).toBe('No season stats')
    })
})

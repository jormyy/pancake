import { describe, expect, it } from 'vitest'
import { isRegularSeasonGameId } from '../src/season/gameId'

describe('isRegularSeasonGameId', () => {
    it('keeps NBA regular-season IDs and historical non-NBA-CDN IDs', () => {
        expect(isRegularSeasonGameId('0022600001')).toBe(true)
        expect(isRegularSeasonGameId('200404140DET')).toBe(true)
    })

    it('rejects NBA preseason, All-Star, playoff, and blank IDs', () => {
        expect(isRegularSeasonGameId('0012600001')).toBe(false)
        expect(isRegularSeasonGameId('0032600001')).toBe(false)
        expect(isRegularSeasonGameId('0042600001')).toBe(false)
        expect(isRegularSeasonGameId('')).toBe(false)
        expect(isRegularSeasonGameId(null)).toBe(false)
    })
})

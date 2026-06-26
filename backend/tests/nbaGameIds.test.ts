import { describe, expect, it } from 'vitest'

import { isRegularSeasonGameId } from '../src/lib/nba'

describe('isRegularSeasonGameId', () => {
    it('only counts NBA API regular-season IDs from the 00x family', () => {
        expect(isRegularSeasonGameId('0022500001')).toBe(true)
        expect(isRegularSeasonGameId('0012500001')).toBe(false)
        expect(isRegularSeasonGameId('0032500001')).toBe(false)
        expect(isRegularSeasonGameId('0042500001')).toBe(false)
        expect(isRegularSeasonGameId('0052500001')).toBe(false)
    })

    it('keeps historical Basketball Reference regular-season IDs countable', () => {
        expect(isRegularSeasonGameId('200312010NJN')).toBe(true)
        expect(isRegularSeasonGameId('')).toBe(false)
        expect(isRegularSeasonGameId(null)).toBe(false)
    })
})

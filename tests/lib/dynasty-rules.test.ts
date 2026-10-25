import { describe, expect, it } from 'vitest'
import { careerRegularSeasonGames } from '../../core/src/roster/careerGames'
import { isTaxiEligible } from '../../core/src/roster/eligibility'

describe('career regular-season games', () => {
    const response = (games: unknown) => ({
        filters: [{ name: 'league', value: 'nba' }, { name: 'seasontype', value: '2' }],
        categories: [{ labels: ['GP', 'PTS'], totals: [games, '1000'] }],
    })

    it('uses the source career aggregate without counting traded-team season rows twice', () => {
        expect(careerRegularSeasonGames({ ...response('64'), statistics: [{ games: 40 }, { games: 24 }, { games: 64 }] })).toBe(64)
        expect(careerRegularSeasonGames(response(0))).toBe(0)
    })

    it('refuses postseason, other leagues, missing counts, and malformed totals', () => {
        expect(careerRegularSeasonGames({ ...response('64'), filters: [{ name: 'league', value: 'nba' }, { name: 'seasontype', value: '3' }] })).toBeNull()
        expect(careerRegularSeasonGames({ ...response('64'), filters: [{ name: 'league', value: 'wnba' }, { name: 'seasontype', value: '2' }] })).toBeNull()
        for (const games of [null, '', '64.5', '-1', 'unknown']) expect(careerRegularSeasonGames(response(games))).toBeNull()
        expect(careerRegularSeasonGames({})).toBeNull()
    })

    it('uses the exact games boundary without a league option', () => {
        expect(isTaxiEligible(0, null)).toBe(true)
        expect(isTaxiEligible(0, 82)).toBe(true)
        expect(isTaxiEligible(5, 64)).toBe(true)
        expect(isTaxiEligible(1, 65)).toBe(false)
        expect(isTaxiEligible(1, null)).toBe(false)
    })
})

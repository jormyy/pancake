import { expect, it } from 'vitest'
import { draftYearForSeason, lastFutureDraftYear, leagueSeasonYear, pickLabel, storedDraftYear } from '@/lib/picks'

it('labels picks with their stored draft year', () => {
    expect(pickLabel(storedDraftYear(2028), 1)).toBe('2028 Round 1')
})

it('places the rookie draft before a league season in the June that ends the prior season', () => {
    expect(pickLabel(draftYearForSeason(leagueSeasonYear(2028)), 2)).toBe('2027 Round 2')
})

it('ends the tradeable window at the last future draft year', () => {
    expect(lastFutureDraftYear(leagueSeasonYear(2027), 5)).toBe(2031)
})

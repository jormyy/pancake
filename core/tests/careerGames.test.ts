import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { careerFirstSeasonYear, careerRegularSeasonGames } from '../src/roster/careerGames'

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../supabase/functions/sync-players/fixtures/${name}.json`, import.meta.url), 'utf8'))
const regular = (raw: unknown) => ({ filters: [{ name: 'league', value: 'nba' }, { name: 'seasontype', value: '2' }],
    categories: [{ names: ['gamesPlayed'], totals: [raw] }] })

describe('career NBA games', () => {
    it('recognizes ESPN no-debut responses only for a known rookie', () => {
        const payload = fixture('espn-no-nba-games')
        expect(careerRegularSeasonGames(payload, 0)).toBe(0)
        expect(careerRegularSeasonGames(payload, null)).toBeNull()
        expect(careerRegularSeasonGames(payload, 1)).toBeNull()
    })

    it('reads the NBA regular-season total across seasons', () => {
        expect(careerRegularSeasonGames(fixture('espn-career-beringer'))).toBe(42)
        expect(careerFirstSeasonYear(fixture('espn-career-beringer'))).toBe(2026)
        expect(careerFirstSeasonYear(fixture('espn-no-nba-games'))).toBeNull()
        expect(careerRegularSeasonGames(regular('0'))).toBe(0)
        expect(careerRegularSeasonGames(regular(65))).toBe(65)
    })

    it('refuses college, playoff and malformed counts', () => {
        const payload = regular('64')
        expect(careerRegularSeasonGames({ ...payload, filters: [{ name: 'league', value: 'mens-college-basketball' }, { name: 'seasontype', value: '2' }] })).toBeNull()
        expect(careerRegularSeasonGames({ ...payload, filters: [{ name: 'league', value: 'nba' }, { name: 'seasontype', value: '3' }] })).toBeNull()
        for (const raw of ['--', '', -1, 2.5, Infinity, '9007199254740992']) expect(careerRegularSeasonGames(regular(raw))).toBeNull()
        for (const raw of [null, {}, { filters: [] }, { filters: 'nba' }, { filters: payload.filters, categories: {} }, { filters: payload.filters, categories: [{ names: ['gamesPlayed'], totals: '64' }] }]) {
            expect(careerRegularSeasonGames(raw)).toBeNull()
        }
    })
})

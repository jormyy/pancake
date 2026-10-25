import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { careerFirstSeasonYear, careerRegularSeasonGames, careerGamesPrior } from '../src/roster/careerGames'

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


describe('career games before local coverage', () => {
    const payload = (rows: unknown[], total: string) => ({
        filters: [{ name: 'league', value: 'nba' }, { name: 'seasontype', value: '2' }],
        categories: [{ names: ['gamesPlayed'], totals: [total], statistics: rows }],
    })
    const row = (year: number, games: string, teamId?: string) => ({ season: { year }, stats: [games], ...(teamId ? { teamId } : { displayName: `${year} Totals` }) })

    it('adds only seasons before 2020-21 and counts a traded season once', () => {
        expect(careerGamesPrior(payload([row(2019, '10', '1'), row(2020, '12', '1'), row(2020, '8', '2'), row(2020, '20'), row(2021, '40', '2')], '70'))).toBe(30)
        expect(careerGamesPrior(fixture('espn-career-beringer'))).toBe(0)
    })

    it('refuses incomplete season history and non-regular totals', () => {
        expect(careerGamesPrior(payload([row(2020, '20', '1')], '70'))).toBeNull()
        expect(careerGamesPrior(payload([], '70'))).toBeNull()
        expect(careerGamesPrior({ ...payload([row(2020, '20')], '20'), filters: [{ name: 'league', value: 'nba' }, { name: 'seasontype', value: '3' }] })).toBeNull()
        expect(careerGamesPrior(payload([row(2020, '--')], '20'))).toBeNull()
    })
})

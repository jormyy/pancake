import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { careerFirstSeasonYear, careerRegularSeasonGames, careerGamesBase } from '../src/roster/careerGames'

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


describe('completed-season career base', () => {
    const payload = (rows: unknown[], total: string) => ({
        filters: [{ name: 'league', value: 'nba' }, { name: 'seasontype', value: '2' }],
        categories: [{ names: ['gamesPlayed'], totals: [total], statistics: rows }],
    })
    const row = (year: number, games: string, teamId?: string) => ({ season: { year }, stats: [games], ...(teamId ? { teamId } : { displayName: `${year} Totals` }) })

    it('uses completed seasons even when local coverage starts late or has holes', () => {
        const cases = fixture('career-base-cases')
        for (const test of cases) {
            const current = test.local.filter(([year]: [number, number]) => year === 2027)
                .reduce((sum: number, [, games]: [number, number]) => sum + games, 0)
            expect(careerGamesBase(test.espn, 2026), test.name).toBe(test.expected - current)
        }
    })

    it('counts a traded completed season once', () => {
        expect(careerGamesBase(payload([row(2025, '10', '1'), row(2026, '12', '1'), row(2026, '8', '2'), row(2026, '20'), row(2027, '40', '2')], '70'), 2026)).toBe(30)
    })

    it('does not let a stale career total or incomplete current season change the base', () => {
        expect(careerGamesBase(payload([row(2026, '99', '1'), row(2027, '--', '1')], '100'), 2026)).toBe(99)
        expect(careerGamesBase(payload([row(2026, '99', '1'), row(2027, '1', '1')], '--'), 2026)).toBe(99)
    })

    it('rejects a truncated season history instead of replacing a veteran base with zero', () => {
        expect(careerGamesBase(payload([row(2027, '2', '1')], '331'), 2026)).toBeNull()
    })

    it('gives a current-season debut a zero completed-season base', () => {
        expect(careerGamesBase(payload([row(2027, '2', '1')], '2'), 2026)).toBe(0)
    })

    it('refuses missing season rows and malformed historical games', () => {
        expect(careerGamesBase(payload([], '70'), 2026)).toBeNull()
        expect(careerGamesBase(payload([row(2026, '--')], '20'), 2026)).toBeNull()
        expect(careerGamesBase(payload([{ stats: ['20'] }], '20'), 2026)).toBeNull()
        expect(careerGamesBase(payload([row(2026, '20', '1'), row(2026, '30')], '30'), 2026)).toBeNull()
    })

    it('refuses college and postseason histories', () => {
        for (const filters of [[{ name: 'league', value: 'nba' }, { name: 'seasontype', value: '3' }],
            [{ name: 'league', value: 'mens-college-basketball' }, { name: 'seasontype', value: '2' }]]) {
            expect(careerGamesBase({ ...payload([row(2026, '20')], '20'), filters }, 2026)).toBeNull()
        }
    })
})

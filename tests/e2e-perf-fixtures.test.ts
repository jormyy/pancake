import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runBrowserPerfSmoke } from './e2e/browser-perf-smoke.mjs'
import { createDisposableLeagueFromSeedUsers, ensureSyntheticSeasonWeeks } from './e2e/soak-fixtures.mjs'
import { createScenarioResourceOwner } from './e2e/scenario-resource-owner.mjs'
import { seasonWeekRows } from './e2e/harness/season-calendar.mjs'

const boundary = vi.hoisted(() => ({ client: vi.fn() }))
const fixtureState = { password: 'fixture-password', users: [{ id: 'U1', email: 'one@fixture.invalid' }, { id: 'U2', email: 'two@fixture.invalid' }] }
const fixtureYear = 5000 + (process.pid % 4000)
vi.mock('@supabase/supabase-js', () => ({ createClient: boundary.client }))
vi.mock('./e2e/env.mjs', () => ({
    resolvedEnv: () => ({ supabaseUrl: 'http://fixture.invalid', serviceRoleKey: 'fixture-key', anonKey: 'fixture-public', apiBaseUrl: 'http://fixture.invalid/api' }),
    requireEnv: (env: unknown) => env,
    describeEndpoint: (value: string) => value,
}))
vi.mock('./e2e/browser-agent.mjs', () => ({
    createBrowser: () => async () => { throw new Error('Fixture tests must not operate a browser') },
    clickButtonByName: vi.fn(), fillSignInCredentials: vi.fn(), listBrowserSessions: vi.fn(),
}))
vi.mock('node:fs/promises', () => ({
    readFile: async (file: string) => {
        if (!file.endsWith('/tests/e2e-state.json')) throw new Error(`Unexpected fixture file read: ${file}`)
        return JSON.stringify(fixtureState)
    },
    mkdir: vi.fn(), writeFile: vi.fn(), readdir: vi.fn(),
}))

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-13T18:30:00Z'))
    vi.stubGlobal('fetch', () => { throw new Error('Fixture tests must not use the network') })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); boundary.client.mockReset() })

type Week = { id: string; season_year: number; week_number: number; week_start: string; week_end: string }
type Reply = { data: unknown; error: { message: string } | null }
const members = [{ id: 'M1', user_id: 'U1', team_name: 'One' }, { id: 'M2', user_id: 'U2', team_name: 'Two' }]

function calendarClient(initial: Week[] = [], failures: Record<string, string> = {}) {
    const weeks = new Map(initial.map((row) => [`${row.season_year}:${row.week_number}`, { ...row }]))
    const writes: string[] = []
    let sequence = 0
    const from = (table: string) => {
        let operation = 'select'
        let values: Record<string, unknown>[] = []
        const filters = new Map<string, unknown>()
        let weekNumbers: unknown[] | null = null
        const resolve = (): Reply => {
            const failure = failures[`${table}.${operation}`]
            if (failure) return { data: null, error: { message: failure } }
            if (table !== 'season_weeks') {
                if (table === 'drafts' && operation === 'insert') throw new Error('Reached auction setup after calendar preparation')
                const data = table === 'leagues' ? { id: 'L', name: 'Fixture league' }
                    : table === 'league_seasons' ? { id: 'S', season_year: fixtureYear }
                        : table === 'league_members' ? members
                            : table === 'players' ? [{ id: 'P', display_name: 'Fixture player' }] : []
                return { data, error: null }
            }
            const selected = [...weeks.values()].filter((row) =>
                (!filters.has('season_year') || row.season_year === filters.get('season_year')) &&
                (!filters.has('week_number') || row.week_number === filters.get('week_number')) &&
                (!weekNumbers || weekNumbers.includes(row.week_number)))
            if (operation === 'select') return { data: selected.map((row) => ({ ...row })), error: null }
            writes.push(operation)
            if (operation === 'delete') {
                for (const row of selected) weeks.delete(`${row.season_year}:${row.week_number}`)
            } else if (operation === 'update') {
                for (const row of selected) weeks.set(`${row.season_year}:${row.week_number}`, { ...row, ...values[0] })
            } else {
                if (operation === 'insert' && values.some((row) => weeks.has(`${row.season_year}:${row.week_number}`))) {
                    return { data: null, error: { message: 'duplicate key value violates unique constraint "season_weeks_season_year_week_number_key"' } }
                }
                for (const row of values) {
                    if (typeof row.season_year !== 'number' || typeof row.week_number !== 'number' ||
                        typeof row.week_start !== 'string' || typeof row.week_end !== 'string') throw new Error('Invalid calendar row')
                    const key = `${row.season_year}:${row.week_number}`
                    weeks.set(key, { id: weeks.get(key)?.id ?? `week-${++sequence}`,
                        season_year: row.season_year, week_number: row.week_number, week_start: row.week_start, week_end: row.week_end })
                }
            }
            return { data: null, error: null }
        }
        const builder = {
            select: () => builder,
            eq: (key: string, value: unknown) => { filters.set(key, value); return builder },
            in: (key: string, numbers: unknown[]) => {
                if (key !== 'week_number') throw new Error(`Unexpected calendar filter: ${key}`)
                weekNumbers = numbers
                return builder
            },
            order: () => builder, limit: () => builder,
            insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => { operation = 'insert'; values = Array.isArray(rows) ? rows : [rows]; return builder },
            upsert: (rows: Record<string, unknown> | Record<string, unknown>[]) => { operation = 'upsert'; values = Array.isArray(rows) ? rows : [rows]; return builder },
            update: (row: Record<string, unknown>) => { operation = 'update'; values = [row]; return builder },
            delete: () => { operation = 'delete'; return builder },
            single: async () => resolve(),
            maybeSingle: async () => {
                const result = resolve()
                return { ...result, data: Array.isArray(result.data) ? result.data[0] ?? null : result.data }
            },
            then: (onFulfilled: (reply: Reply) => unknown, onRejected?: (error: unknown) => unknown) =>
                Promise.resolve().then(resolve).then(onFulfilled, onRejected),
        }
        return builder
    }
    return { from, weeks, writes }
}

describe('performance calendar fixtures', () => {
    it('reuses synthetic week 1 around today and removes all owned calendar rows after setup', async () => {
        const client = calendarClient()
        boundary.client.mockReturnValue(client)
        const owner = createScenarioResourceOwner('performance fixture')
        try {
            await expect(Reflect.apply(runBrowserPerfSmoke, undefined, [{ season: 1, resourceOwner: owner }]))
                .rejects.toThrow('Reached auction setup after calendar preparation')
            expect(client.weeks.size).toBe(26)
            expect(client.weeks.get(`${fixtureYear}:1`)).toMatchObject({ week_start: '2026-10-12', week_end: '2026-10-18' })
            expect(client.writes).not.toContain('insert')
            expect([...client.weeks.values()].filter((week) => week.week_start <= '2026-10-13' && week.week_end >= '2026-10-13'))
                .toEqual([client.weeks.get(`${fixtureYear}:1`)])
        } finally { await owner.dispose() }
        expect(client.weeks.size).toBe(0)
    })

    it('restores pre-existing calendar dates and IDs while preserving weeks outside the owned range', async () => {
        const prior = [...seasonWeekRows(fixtureYear, 2), ...seasonWeekRows(fixtureYear, 40).slice(-1)]
            .map((week, index) => ({ ...week, id: `existing-${index}`, week_start: index === 0 ? '2025-01-01' : week.week_start }))
        const client = calendarClient(prior)
        boundary.client.mockReturnValue(client)
        const owner = createScenarioResourceOwner('existing calendar')
        try {
            await expect(Reflect.apply(runBrowserPerfSmoke, undefined, [{ season: 1, resourceOwner: owner }]))
                .rejects.toThrow('Reached auction setup after calendar preparation')
            expect(client.weeks.get(`${fixtureYear}:1`)).toMatchObject({ id: 'existing-0', week_start: '2026-10-12' })
        } finally { await owner.dispose() }
        expect([...client.weeks.values()]).toEqual(prior)
    })

    it('cleans up the calendar when league creation fails after the weeks are written', async () => {
        const client = calendarClient([], { 'leagues.insert': 'Injected league failure' })
        const owner = createScenarioResourceOwner('failed league')
        await expect(Reflect.apply(createDisposableLeagueFromSeedUsers, undefined, [{ supabase: client, state: fixtureState,
            season: 1, seasonYear: fixtureYear, label: 'fixture', userCount: 2, resourceOwner: owner }]))
            .rejects.toThrow('Injected league failure')
        expect(client.weeks.size).toBe(26)
        await owner.dispose()
        expect(client.weeks.size).toBe(0)
    })

    it('restores the original calendar after repeated fills and removes owned future-season weeks', async () => {
        const prior = seasonWeekRows(fixtureYear, 1).map((week) => ({ ...week, id: 'existing-week' }))
        const client = calendarClient(prior)
        const owner = createScenarioResourceOwner('multiple fills')
        await Reflect.apply(ensureSyntheticSeasonWeeks, undefined, [client, fixtureYear, 26, 'initial', owner])
        await Reflect.apply(ensureSyntheticSeasonWeeks, undefined, [client, fixtureYear, 30, 'extended', owner])
        await Reflect.apply(ensureSyntheticSeasonWeeks, undefined, [client, fixtureYear + 1, 26, 'next season', owner])
        expect(client.weeks.size).toBe(56)
        await owner.dispose()
        expect([...client.weeks.values()]).toEqual(prior)
    })
})

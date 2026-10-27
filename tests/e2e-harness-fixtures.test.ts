import { afterEach, describe, expect, it, vi } from 'vitest'
import { maskSqlNonCode } from '../scripts/check-db-function-sources.mjs'
import { PLAYER_REFERENCE_TABLES, deletePlayersWithReferences } from './e2e/harness-cleanup.mjs'
import { createDisposableLeagueFromSeedUsers, ensureRosterFixture, ensureSyntheticSeasonWeeks } from './e2e/soak-fixtures.mjs'
import { createFakeUpstreamServer } from './e2e/fake-upstream.mjs'
import { backendAuthedJson } from './e2e/soak-network.mjs'
import { assertSeasonResetScenario, assertWeeklyScoringFinalizationScenario } from './e2e/soak-scoring-reset.mjs'
import { ensureHistoryFixtureForSeason } from './e2e/soak-support.mjs'
import { completeSoakSeason, prepareSoakSeason, readSoakSeason, rolloverSoakSeason } from './e2e/harness/season-loop.mjs'
import { seasonWeekRows } from './e2e/harness/season-calendar.mjs'
import { runInvariants } from './e2e/soak-realtime-invariants.mjs'
import { assertInjuryStatusFilterScenario } from './e2e/soak-trade-lifecycle.mjs'
import { createScenarioResourceOwner } from './e2e/scenario-resource-owner.mjs'

afterEach(() => { vi.unstubAllGlobals(); boundaryQueries.read.mockReset() })

describe('trade request identity', () => {
    it('sends a new request ID for trade actions and keeps caller IDs for retries', async () => {
        const fetch = vi.fn(async (_url: unknown, _options: { body: string }) => ({ ok: true, json: async () => ({ ok: true }) }))
        vi.stubGlobal('fetch', fetch)
        const env = { apiBaseUrl: 'http://fixture.invalid/api' }
        await backendAuthedJson(env, '/trades/propose', 'fixture-token', { memberId: 'member' })
        await backendAuthedJson(env, '/trades/propose', 'fixture-token', { memberId: 'member' })
        const first = JSON.parse(fetch.mock.calls[0][1].body) as { requestId: string }
        const second = JSON.parse(fetch.mock.calls[1][1].body) as { requestId: string }
        expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/)
        expect(second.requestId).not.toBe(first.requestId)
        await backendAuthedJson(env, '/trades/propose', 'fixture-token', { requestId: first.requestId })
        expect(JSON.parse(fetch.mock.calls[2][1].body).requestId).toBe(first.requestId)
    })
})

type FakeRequest = AsyncIterable<Buffer> & { method: string; url: string }
type FakeResponse = { writeHead: (status: number) => void; end: (body: string) => void }
type Handler = (request: FakeRequest, response: FakeResponse) => Promise<unknown>
const httpBoundary = vi.hoisted(() => ({ handlers: [] as Handler[] }))
const boundaryQueries = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('node:http', () => ({ default: { createServer: (handler: Handler) => {
    httpBoundary.handlers.push(handler)
    return { listen: (_port: number, done: () => void) => done(), close: (done: () => void) => done() }
} } }))
// These fixture tests never load project credentials or start a real backend.
vi.mock('./e2e/env.mjs', () => ({
    resolvedEnv: () => { throw new Error('Fixture tests must not resolve credentials') },
    describeEndpoint: (value: string) => value,
    envValue: () => undefined,
    loadEnvFile: () => { throw new Error('Fixture tests must not read env files') },
    isProductionSupabaseUrl: () => false,
    querySupabaseDb: boundaryQueries.read,
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
    ...await importOriginal<typeof import('node:fs/promises')>(),
    writeFile: vi.fn(async () => undefined),
}))

type Schedule = { leagueSchedule: { seasonYear: string; gameDates: {
    gameDate: string; games: { gameId: string; weekNumber: number; gameDateEst: string }[]
}[] } }
const fakeRequest = async (method: string, url: string, body: unknown = {}) => {
    let status = 0
    let text = ''
    await httpBoundary.handlers.at(-1)!({
        method, url, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
    }, { writeHead: (value) => { status = value }, end: (value) => { text = value } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
}
const schedule = async () => (await fakeRequest('GET', '/staticData/scheduleLeagueV2_1.json')).body as unknown as Schedule

describe('fake NBA season calendar', () => {
    it('covers all regular and playoff weeks, including the next calendar year', async () => {
        createFakeUpstreamServer()
        const payload = await schedule()
        const games = payload.leagueSchedule.gameDates.flatMap((day) => day.games)
        expect([...new Set(games.map((game) => game.weekNumber))]).toEqual(Array.from({ length: 26 }, (_, index) => index + 1))
        expect(payload.leagueSchedule.gameDates.some((day) => day.gameDate.startsWith('2027-'))).toBe(true)
        expect(payload.leagueSchedule.seasonYear).toBe('2026-27')
        expect(games.every((game) => /^002\d{7}$/.test(game.gameId))).toBe(true)
    })

    it('starts in the requested league season and covers its configured playoff window', async () => {
        Reflect.apply(createFakeUpstreamServer, undefined, [{ seasonYear: 2030, calendarWeeks: 30 }])
        const payload = await schedule()
        expect(payload.leagueSchedule.seasonYear).toBe('2029-30')
        expect(Math.max(...payload.leagueSchedule.gameDates.flatMap((day) => day.games.map((game) => game.weekNumber)))).toBe(30)
    })

    it('keeps Monday-Sunday week numbers through twenty advances and a checkpoint restore', async () => {
        const first = createFakeUpstreamServer()
        for (let season = 0; season < 20; season += 1) {
            const payload = await schedule()
            const dates = payload.leagueSchedule.gameDates
            const firstDate = Date.parse(`${dates[0].gameDate}T00:00:00Z`)
            const monday = firstDate - ((new Date(firstDate).getUTCDay() + 6) % 7) * 86_400_000
            for (const day of dates) {
                const week = Math.floor((Date.parse(`${day.gameDate}T00:00:00Z`) - monday) / (7 * 86_400_000)) + 1
                expect(day.games.every((game) => game.weekNumber === week)).toBe(true)
            }
            expect(new Set(dates.flatMap((day) => day.games.map((game) => game.weekNumber))).size).toBe(26)
            await fakeRequest('POST', '/admin/advance-season')
        }
        const saved = JSON.parse(JSON.stringify(first.exportState()))
        const second = createFakeUpstreamServer()
        second.restoreState(saved)
        expect(second.exportState()).toEqual(saved)
        const before = await schedule()
        await fakeRequest('POST', '/admin/advance-season')
        expect((await schedule()).leagueSchedule.seasonYear).not.toBe(before.leagueSchedule.seasonYear)
    })

    it('does not invent a Final empty box score for an unknown game', async () => {
        createFakeUpstreamServer()
        expect((await fakeRequest('GET', '/liveData/boxscore/boxscore_missing.json')).status).toBe(404)
    })

    it('completes only the selected season with real player rows on both sides', async () => {
        const fake = createFakeUpstreamServer()
        const firstIds = new Set(fake.state.games.keys())
        await fakeRequest('POST', '/admin/advance-season')
        expect((await fakeRequest('POST', '/admin/complete-season')).status).toBe(200)
        for (const [id, game] of fake.state.games) {
            if (firstIds.has(id)) { expect(game.gameStatus).toBe(1); continue }
            expect(game.gameStatus).toBe(3)
            for (const side of ['homeTeam', 'awayTeam'] as const) {
                expect(game[side].players.length).toBeGreaterThan(0)
                expect(game[side].score).toBe(game[side].players.reduce((total: number, player: { statistics: { points: number } }) => total + player.statistics.points, 0))
            }
        }
    })

    it('preserves a wider calendar at a shard handoff and rejects an invalid width', async () => {
        const first = createFakeUpstreamServer({ seasonYear: 2030, calendarWeeks: 30 })
        const saved = JSON.parse(JSON.stringify(first.exportState()))
        const next = createFakeUpstreamServer()
        next.restoreState(saved)
        await fakeRequest('POST', '/admin/advance-season')
        expect(new Set((await schedule()).leagueSchedule.gameDates.flatMap((day) => day.games.map((game) => game.weekNumber))).size).toBe(30)
        expect(() => next.restoreState({ ...saved, calendarWeeks: 0 })).toThrow('incomplete')
    })

    it('keeps all past box scores stable through ten seasons, current mutations and a checkpoint restore', async () => {
        let fake = createFakeUpstreamServer()
        const completed = new Map<string, string>()
        for (let season = 0; season < 10; season++) {
            const current = [...fake.state.games.values()].filter((game) => Number(game.gameDate.slice(0, 4)) +
                (Number(game.gameDate.slice(5, 7)) >= 10 ? 1 : 0) === fake.state.seasonYear)
            expect(current).toHaveLength(52)
            expect(current.every((game) => !completed.has(game.gameId))).toBe(true)
            await fakeRequest('POST', '/admin/player-stat', { gameId: current[0].gameId, teamSide: 'awayTeam',
                personId: 1001, name: 'Ari Glass', stats: { points: 24 + season, minutes: 32 } })
            await fakeRequest('POST', '/admin/complete-season')
            for (const [id, before] of completed) {
                expect(JSON.stringify(fake.state.games.get(id)), id).toBe(before)
                expect(JSON.stringify((await fakeRequest('GET', `/liveData/boxscore/boxscore_${id}.json`)).body.game), id).toBe(before)
            }
            for (const game of current) completed.set(game.gameId, JSON.stringify(game))
            if (season === 4) {
                const saved = fake.exportState()
                fake = createFakeUpstreamServer()
                fake.restoreState(saved)
            }
            await fakeRequest('POST', '/admin/advance-season')
        }
        expect(completed.size).toBe(520)
    })
})

describe('disposable calendar fixtures', () => {
    it('uses the fixture season year and contiguous Monday-Sunday dates', async () => {
        const client = fakeClient()
        await ensureSyntheticSeasonWeeks(client, 3001, 26, 'calendar')
        const rows = client.calls.find((call) => call.table === 'season_weeks' && call.op === 'upsert')!.args[0] as {
            season_year: number; week_number: number; week_start: string; week_end: string
        }[]
        expect(rows).toHaveLength(26)
        for (const [index, row] of rows.entries()) {
            expect(row.season_year).toBe(3001)
            expect(row.week_number).toBe(index + 1)
            expect(new Date(`${row.week_start}T00:00:00Z`).getUTCDay()).toBe(1)
            expect(new Date(`${row.week_end}T00:00:00Z`).getUTCDay()).toBe(0)
            expect(Number(row.week_start.slice(0, 4))).toBeGreaterThanOrEqual(3000)
            expect(Number(row.week_end.slice(0, 4))).toBeLessThanOrEqual(3001)
        }
    })

    it('loads a calendar before a disposable league can change playoff settings', async () => {
        const client = fakeClient({
            'leagues.insert': { data: { id: 'L' }, error: null },
            'league_seasons.insert': { data: { id: 'S', season_year: 3001 }, error: null },
            'league_members.insert': { data: [{ id: 'M1', user_id: 'U1' }, { id: 'M2', user_id: 'U2' }], error: null },
        })
        await createDisposableLeagueFromSeedUsers({
            supabase: client, state: { password: 'fixture', users: [{ id: 'U1' }, { id: 'U2' }] },
            season: 1, label: 'fixture', userCount: 2, resourceOwner: { register: vi.fn() },
        })
        const call = client.calls.find((call) => call.table === 'season_weeks' && call.op === 'upsert')
        expect(call).toBeDefined()
        expect(call!.args[0]).toHaveLength(26)
    })
})

type Call = { table: string; op: string; args: unknown[] }

// Minimal PostgREST-builder stand-in: records every call, resolves with the
// scripted result for `${table}.${op}`.
function fakeClient(results: Record<string, unknown> = {}) {
    const calls: Call[] = []
    const from = (table: string) => {
        const state = { op: 'select' }
        const builder: Record<string, unknown> = {}
        const chain = (op: string) => (...args: unknown[]) => {
            calls.push({ table, op, args })
            if (['delete', 'insert', 'upsert', 'update'].includes(op)) state.op = op
            return builder
        }
        for (const op of ['select', 'delete', 'insert', 'upsert', 'update', 'like', 'in', 'eq', 'is', 'order', 'limit', 'range', 'not']) builder[op] = chain(op)
        const resolve = () => {
            const result = results[`${table}.${state.op}`]
            return typeof result === 'function' ? result() : result ?? { data: null, error: null, count: 0 }
        }
        builder.maybeSingle = async () => resolve()
        builder.single = async () => resolve()
        builder.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
            Promise.resolve(resolve()).then(onFulfilled, onRejected)
        return builder
    }
    const rpc = async (name: string, args: unknown) => {
        calls.push({ table: '$rpc', op: name, args: [args] })
        return results[`rpc.${name}`] ?? { data: null, error: null }
    }
    return { from, calls, rpc }
}

describe('injury scenario scoring isolation', () => {
    it.each([false, true])('preserves past stats, completion stamps and scoring-player metadata when sync fails=%s', async (failSync) => {
        const fake = createFakeUpstreamServer()
        await fakeRequest('POST', '/admin/complete-season')
        await fakeRequest('POST', '/admin/advance-season')
        await fakeRequest('POST', '/admin/complete-season')
        await fakeRequest('POST', '/admin/advance-season')
        const pastGames = [...fake.state.games.values()].filter((game) => game.gameStatus === 3)
        const boxScoresBefore = pastGames.map((game) => JSON.stringify(game))
        const players = new Map<string, Record<string, unknown>>([...fake.state.players.values()].map((player) => [player.player_id, {
            id: `player-${player.player_id}`, sleeper_id: player.player_id, first_name: player.first_name, last_name: player.last_name,
            sportsdata_id: `fixture-${player.player_id}`, position: player.position, eligible_positions: [],
            nba_team: player.team, years_exp: player.years_exp, injury_status: null, status: 'Active',
        }]))
        let stats = pastGames.flatMap((game) => [...game.homeTeam.players, ...game.awayTeam.players].map((player) => ({
            player_id: `player-${player.personId}`, game_id: game.gameId, points: player.statistics.points,
        })))
        const scoringPlayerIds = new Set(stats.map((row) => row.player_id))
        const stamps = new Map(pastGames.map((game) => [game.gameId, 'completed']))
        const statsBefore = structuredClone(stats)
        const stampsBefore = new Map(stamps)
        const scoringPlayerWrites: string[] = []
        let client: ReturnType<typeof fakeClient>
        client = fakeClient({
            'players.select': () => {
                const filter = client.calls.findLast((call) => call.table === 'players' && call.op === 'eq')!
                expect(filter.args[0]).toBe('sleeper_id')
                const player = players.get(String(filter.args[1]))
                return { data: player ? [{ ...player }] : [], error: null }
            },
            'players.update': () => {
                const fields = client.calls.findLast((call) => call.table === 'players' && call.op === 'update')!.args[0] as Record<string, unknown>
                const id = String(client.calls.findLast((call) => call.table === 'players' && call.op === 'eq')!.args[1])
                if (scoringPlayerIds.has(id)) scoringPlayerWrites.push(id)
                const entry = [...players.entries()].find(([, player]) => player.id === id)!
                players.set(entry[0], { ...entry[1], ...fields })
                return { data: { ...players.get(entry[0]) }, error: null }
            },
            'player_game_stats.delete': () => {
                const filter = client.calls.findLast((call) => call.table === 'player_game_stats' && call.op === 'in')!
                expect(filter.args[0]).toBe('player_id')
                const ids = filter.args[1] as string[]
                for (const row of stats) if (ids.includes(row.player_id)) stamps.set(row.game_id, '')
                stats = stats.filter((row) => !ids.includes(row.player_id))
                return { data: null, error: null }
            },
        })
        vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
            const url = new URL(input)
            if (url.hostname === 'fixture.invalid') {
                if (url.pathname === '/e2e/status') return Response.json({ sleeperBaseUrl: 'http://127.0.0.1:4555/v1' })
                expect(url.pathname).toBe('/e2e/sync-players')
                if (failSync) return Response.json({ error: 'Injected sync failure' }, { status: 503 })
                for (const player of fake.state.players.values()) {
                    const stored = players.get(player.player_id)
                    if (stored) players.set(player.player_id, { ...stored, nba_team: player.team, years_exp: player.years_exp,
                        eligible_positions: [], injury_status: player.injury_status === 'Scrambled' ? null : player.injury_status })
                }
                return Response.json({ ok: true })
            }
            expect(url.hostname).toBe('127.0.0.1')
            const response = await fakeRequest(init.method ?? 'GET', url.pathname, init.body ? JSON.parse(String(init.body)) : {})
            return Response.json(response.body, { status: response.status })
        })
        const owner = createScenarioResourceOwner('injury isolation')
        try {
            const run = assertInjuryStatusFilterScenario({ supabase: client, env: { apiBaseUrl: 'http://fixture.invalid' },
                season: 3, fakePort: 4555, resourceOwner: owner })
            if (failSync) await expect(run).rejects.toThrow('/e2e/sync-players returned 503')
            else await expect(run).resolves.toMatchObject({ failures: [], artifact: { failures: [] } })
        } finally { await owner.dispose() }
        expect(stats).toHaveLength(statsBefore.length)
        expect(stats).toEqual(statsBefore)
        expect(stamps).toEqual(stampsBefore)
        expect(scoringPlayerWrites).toEqual([])
        expect(pastGames.map((game) => JSON.stringify(game))).toEqual(boxScoresBefore)
    })
})

const fixtureMembers = Array.from({ length: 4 }, (_, index) => ({
    id: `member-${index}`, user_id: `user-${index}`, team_name: `Team ${index}`,
}))
const scenarioClient = (results: Record<string, unknown> = {}) => {
    let game = 0
    return fakeClient({
        'leagues.insert': { data: { id: 'league' }, error: null },
        'league_seasons.insert': { data: { id: 'season', season_year: 6001 }, error: null },
        'league_members.insert': { data: fixtureMembers, error: null },
        'players.select': { data: Array.from({ length: 5 }, (_, index) => ({ id: `player-${index}` })), error: null },
        'nba_games.insert': () => ({ data: { id: `game-${++game}` }, error: null }),
        'rpc.propose_trade_atomic': { data: 'taxi-trade', error: null },
        'roster_players.select': { data: { is_on_taxi: true }, error: null },
        'matchups.insert': { data: { id: 'matchup' }, error: null },
        ...results,
    })
}
const scenarioContext = (supabase: ReturnType<typeof fakeClient>) => ({
    supabase, env: { apiBaseUrl: 'http://fixture.invalid/api' }, season: 1,
    state: { password: 'fixture-password', users: fixtureMembers.map((member) => ({ id: member.user_id })) },
    resourceOwner: { register: () => {} },
})

describe('guarded scoring and reset fixtures', () => {
    it('uses a real season week and saves complete box scores through the atomic RPC', async () => {
        const client = scenarioClient()
        vi.stubGlobal('fetch', async () => { throw new Error('stop at score sync') })
        await expect(assertWeeklyScoringFinalizationScenario(scenarioContext(client))).rejects.toThrow('stop at score sync')
        const inserts = client.calls.filter((call) => call.table === 'nba_games' && call.op === 'insert')
        expect(inserts.map((call) => call.args[0])).toEqual([
            expect.objectContaining({ season_year: 6001, week_number: 1, game_date: '6000-10-16' }),
            expect.objectContaining({ season_year: 6001, week_number: 1, game_date: '6000-10-17' }),
        ])
        const saves = client.calls.filter((call) => call.op === 'save_game_stats_atomic')
        expect(saves).toHaveLength(2)
        for (const save of saves) {
            const args = save.args[0] as { p_is_final: boolean; p_stats: { did_not_play: boolean; minutes_played: number }[] }
            expect(args.p_is_final).toBe(false)
            expect(args.p_stats.every((row) => row.did_not_play === false && row.minutes_played > 0)).toBe(true)
        }
        expect(client.calls.some((call) => call.table === 'player_game_stats' && call.op === 'insert')).toBe(false)
    })

    it('acquires the reset taxi player through a pending trade before choosing its destination', async () => {
        const client = scenarioClient()
        vi.stubGlobal('fetch', async () => { throw new Error('stop at season reset') })
        await expect(assertSeasonResetScenario(scenarioContext(client))).rejects.toThrow('stop at season reset')
        const initial = client.calls.find((call) => call.table === 'roster_players' && call.op === 'insert')!.args[0] as { is_on_taxi: boolean }[]
        expect(initial.every((row) => !row.is_on_taxi)).toBe(true)
        expect(client.calls.filter((call) => call.table === '$rpc').map((call) => call.op)).toEqual([
            'propose_trade_atomic', 'set_trade_taxi_destinations_atomic', 'accept_trade_atomic', 'complete_accepted_trade_atomic',
        ])
        expect(client.calls.find((call) => call.op === 'set_trade_taxi_destinations_atomic')!.args[0]).toMatchObject({
            p_trade_id: 'taxi-trade', p_member_id: 'member-2', p_user_id: 'user-2', p_player_ids: ['player-2'],
        })
    })
    it('certifies both Final box scores before replaying an elapsed week and retains all scoring assertions', async () => {
        let matchupRead = 0
        let standingsRead = 0
        const client = scenarioClient({
            'matchups.select': () => ({ data: {
                home_points: 65.7, away_points: 48.4,
                is_finalized: ++matchupRead > 1, winner_member_id: 'member-0',
                home_max_possible_points: 65.7, away_max_possible_points: 48.4,
            }, error: null }),
            'standings.select': () => ({ count: ++standingsRead > 1 ? 2 : 0, error: null }),
        })
        const requests: { date: string }[] = []
        vi.stubGlobal('fetch', async (_url: string, options: { body: string }) => {
            requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true }) }
        })
        const result = await assertWeeklyScoringFinalizationScenario(scenarioContext(client))
        expect(result.failures).toEqual([])
        expect(client.calls.filter((call) => call.op === 'save_game_stats_atomic').map((call) =>
            (call.args[0] as { p_is_final: boolean }).p_is_final)).toEqual([false, false, true, true])
        expect(requests.map((request) => request.date)).toEqual(['6000-10-16T12:00:00Z', '6000-10-23T12:00:00Z'])
        expect(client.calls.filter((call) => call.table === 'nba_games' && call.op === 'update').every((call) =>
            !Object.hasOwn(call.args[0] as object, 'stats_synced_at'))).toBe(true)
    })
    it('does not reach score sync when the complete box score RPC rejects the fixture', async () => {
        const client = scenarioClient({ 'rpc.save_game_stats_atomic': { data: null, error: { message: 'unresolved game identity' } } })
        const request = vi.fn()
        vi.stubGlobal('fetch', request)
        await expect(assertWeeklyScoringFinalizationScenario(scenarioContext(client))).rejects.toThrow('unresolved game identity')
        expect(request).not.toHaveBeenCalled()
    })
})

describe('completed season history', () => {
    const standings = fixtureMembers.map((member, index) => ({
        member_id: member.id, week_number: 19, wins: 19 - index, losses: index, ties: 0,
        points_for: 1200 - index, points_against: 900 + index, max_possible_points: 1300, waiver_priority: index + 1,
    }))
    const clientFor = (finals: unknown[]) => fakeClient({
        'league_members.select': { data: fixtureMembers, error: null },
        'standings.select': { data: standings, error: null },
        'matchups.select': { data: finals, error: null },
        'matchups.insert': { data: { id: 'invented-final' }, error: null },
    })
    it('captures the scored standings and champion without inventing extra weeks or winners', async () => {
        const client = clientFor([{ id: 'final', home_member_id: 'member-0', away_member_id: 'member-1',
            winner_member_id: 'member-1', is_finalized: true }])
        const fixture = await ensureHistoryFixtureForSeason(client, 'league', { id: 'season', season_year: 2028 })
        expect(fixture.weekNumber).toBe(19)
        expect(fixture.standings).toEqual(standings)
        expect(fixture.championMemberId).toBe('member-1')
        expect(fixture.championMatchupId).toBe('final')
        expect(client.calls.some((call) => call.op === 'insert')).toBe(false)
    })
    it('fails when the playoff final is not completed instead of manufacturing a champion', async () => {
        await expect(ensureHistoryFixtureForSeason(clientFor([]), 'league', { id: 'season', season_year: 2028 }))
            .rejects.toThrow('completed playoff final')
    })
    it('rejects missing member standings and a winner outside the final pairing', async () => {
        const client = clientFor([{ id: 'final', home_member_id: 'member-0', away_member_id: 'member-1',
            winner_member_id: 'member-3', is_finalized: true }])
        await expect(ensureHistoryFixtureForSeason(client, 'league', { id: 'season', season_year: 2028 })).rejects.toThrow('completed playoff final')
        const missing = fakeClient({ 'league_members.select': { data: fixtureMembers, error: null },
            'standings.select': { data: standings.slice(1), error: null } })
        await expect(ensureHistoryFixtureForSeason(missing, 'league', { id: 'season', season_year: 2028 })).rejects.toThrow('every league member')
    })
})

describe('rollover pick horizon invariant', () => {
    it('reads the current season year and detects every missing future pick', async () => {
        const seasonRow = { id: 'season', league_id: 'league', is_current: true }
        const client = fakeClient({
            'leagues.select': { data: [{ id: 'league' }], error: null },
            'league_seasons.select': () => ({ data: [{ ...seasonRow,
                ...(client.calls.some((call) => call.table === 'league_seasons' && call.op === 'select' && String(call.args[0]).includes('season_year'))
                    ? { season_year: 2030 } : {}) }], error: null }),
            'league_members.select': { data: fixtureMembers.map((member) => ({ ...member, league_id: 'league' })), error: null },
        })
        const failures = await runInvariants(client, 'league')
        expect(failures).toHaveLength(36)
        expect(failures).toContain('D.SEA.6: league league missing future pick 2031 round 1 for member member-0')
        expect(failures).toContain('D.SEA.6: league league missing future pick 2033 round 3 for member member-3')
    })
})

describe('full simulated season loop', () => {
    const env = { apiBaseUrl: 'http://fixture.invalid/api' }
    const season = { id: 'season', season_year: 2030, playoff_start_week: 20 }
    const setup = (applied = true, finalizes = true) => {
        const fake = createFakeUpstreamServer({ seasonYear: 2030 })
        const steps: string[] = []
        const dates: string[] = []
        let scores = 0
        vi.stubGlobal('fetch', async (url: string, options: { body: string }) => {
            const route = new URL(url).pathname.replace('/api', '')
            const body = JSON.parse(options.body) as { date?: string }
            steps.push(route)
            if (route === '/e2e/sync-stats') dates.push(body.date!)
            if (route === '/e2e/sync-scores') scores += 1
            return { ok: true, json: async () => ({ ok: true }) }
        })
        const client = fakeClient({ 'matchups.select': () => ({ data: finalizes && scores >= 4
            ? [{ id: 'final', is_finalized: true, winner_member_id: 'member-0' }] : [], error: null }) })
        const rpc = vi.fn(async (name: string, args: { p_action: string; p_league_season_id: string; p_reference_at: string }) => {
            expect(name).toBe('apply_season_boundary_after_grace')
            expect(args.p_league_season_id).toBe('season')
            expect(Date.parse(args.p_reference_at) - Date.now()).toBeGreaterThan(48 * 60 * 60 * 1000)
            steps.push(`boundary:${args.p_action}`)
            return { data: { applied }, error: null }
        })
        return { fake, steps, dates, rpc, context: { supabase: { ...client, rpc }, env, fake, fakePort: 4556, leagueId: 'league', season } }
    }
    it('imports every date, scores each round, and requires certified boundaries before declaring a champion', async () => {
        const { context, steps, dates, rpc } = setup()
        await completeSoakSeason(context)
        expect(steps.slice(0, 2)).toEqual(['/admin/complete-season', '/e2e/sync-schedule'])
        expect(dates).toHaveLength(52)
        expect(new Set(dates).size).toBe(52)
        expect(dates[0]).toBe(`${seasonWeekRows(2030)[0].week_start}T23:59:59Z`)
        expect(dates.at(-1)).toBe(`${seasonWeekRows(2030).at(-1)!.week_end}T23:59:59Z`)
        expect(steps.slice(-7)).toEqual(['/e2e/sync-scores', 'boundary:generate', '/e2e/sync-scores',
            'boundary:advance', '/e2e/sync-scores', 'boundary:advance', '/e2e/sync-scores'])
        expect(rpc).toHaveBeenCalledTimes(3)
    })
    it('fails closed when a score certificate or prerequisite is not ready', async () => {
        const { context, steps } = setup(false)
        await expect(completeSoakSeason(context)).rejects.toThrow('boundary declined')
        expect(steps.filter((step) => step.startsWith('boundary:'))).toEqual(['boundary:generate'])
    })
    it('does not reach the boundary after a failed stats import', async () => {
        const { context, rpc } = setup()
        vi.stubGlobal('fetch', async (url: string) => ({ ok: !url.endsWith('/sync-stats'), status: 500,
            text: async () => 'unresolved player', json: async () => ({ ok: true }) }))
        await expect(completeSoakSeason(context)).rejects.toThrow('unresolved player')
        expect(rpc).not.toHaveBeenCalled()
    })
    it('rejects a mismatched season before any upstream request', async () => {
        const { context, rpc } = setup()
        context.fake.state.seasonYear = 2031
        await expect(completeSoakSeason(context)).rejects.toThrow('current league season')
        expect(rpc).not.toHaveBeenCalled()
    })
    it('rejects an unfinished bracket after the bounded round loop', async () => {
        await expect(completeSoakSeason(setup(true, false).context)).rejects.toThrow('no finalized champion')
    })
    it('requires the certified automatic rollover and returns its new current season', async () => {
        const rpc = vi.fn(async () => ({ data: { applied: true, new_season_id: 'next', new_year: 2031 }, error: null }))
        await expect(rolloverSoakSeason({ supabase: { rpc }, leagueId: 'league', season }))
            .resolves.toEqual({ newSeasonId: 'next', newYear: 2031 })
        expect(rpc).toHaveBeenCalledWith('apply_season_boundary_after_grace', expect.objectContaining({
            p_league_id: 'league', p_league_season_id: 'season', p_action: 'rollover',
        }))
        rpc.mockResolvedValueOnce({ data: { applied: false, new_season_id: 'next', new_year: 2031 }, error: null })
        await expect(rolloverSoakSeason({ supabase: { rpc }, leagueId: 'league', season })).rejects.toThrow('rollover boundary declined')
    })
    it('uses the current league year and its configured playoff width', async () => {
        const client = fakeClient({
            'league_seasons.select': { data: season, error: null },
            'leagues.select': { data: { playoff_start_week: 26, playoff_round_weeks: [2, 2, 2] }, error: null },
        })
        expect(await readSoakSeason(client, 'league')).toMatchObject({ season_year: 2030, calendarWeeks: 31 })
    })
    it('replaces only an incomplete seed schedule through the guarded API and verifies all regular weeks exist', async () => {
        const bodies: unknown[] = []
        vi.stubGlobal('fetch', async (_url: string, options: { body: string }) => {
            bodies.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true }) }
        })
        let reads = 0
        const client = fakeClient({ 'season_weeks.select': { data: { week_start: '2029-10-15' }, error: null },
            'league_members.select': { count: 10, error: null },
            'matchups.select': () => ({ data: Array.from({ length: ++reads === 1 ? 1 : 95 }, (_, id) => ({ id: `matchup-${id}` })), error: null }) })
        await prepareSoakSeason({ supabase: client, env, leagueId: 'league', season })
        expect(bodies).toEqual([{ leagueId: 'league', force: true }])
        expect(client.calls.filter((call) => call.op === 'delete')).toHaveLength(0)
    })
    it('preserves a complete schedule and rejects incomplete results or a started-schedule guard', async () => {
        const bodies: unknown[] = []
        vi.stubGlobal('fetch', async (_url: string, options: { body: string }) => {
            bodies.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true }) }
        })
        const client = fakeClient({ 'season_weeks.select': { data: { week_start: '2029-10-15' }, error: null },
            'league_members.select': { count: 10, error: null },
            'matchups.select': { data: Array.from({ length: 95 }, (_, id) => ({ id: `matchup-${id}` })), error: null } })
        await prepareSoakSeason({ supabase: client, env, leagueId: 'league', season })
        expect(bodies).toEqual([{ leagueId: 'league', force: false }])
        const partial = fakeClient({ 'season_weeks.select': { data: { week_start: '2029-10-15' }, error: null },
            'league_members.select': { count: 10, error: null },
            'matchups.select': { data: [{ id: 'incomplete' }], error: null } })
        await expect(prepareSoakSeason({ supabase: partial, env, leagueId: 'league', season })).rejects.toThrow('expected 95')
        vi.stubGlobal('fetch', async () => ({ ok: false, status: 400, text: async () => 'current schedule has started' }))
        await expect(prepareSoakSeason({ supabase: partial, env, leagueId: 'league', season })).rejects.toThrow('schedule has started')
    })
    it('refuses to force an incomplete schedule once the first week starts', async () => {
        const request = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
        let reads = 0
        vi.stubGlobal('fetch', request)
        const client = fakeClient({ 'league_members.select': { count: 10, error: null },
            'matchups.select': () => ({ data: Array.from({ length: ++reads === 1 ? 1 : 95 }, (_, id) => ({ id: `matchup-${id}` })), error: null }),
            'season_weeks.select': { data: { week_start: '2020-10-19' }, error: null } })
        await expect(prepareSoakSeason({ supabase: client, env, leagueId: 'league', season }))
            .rejects.toThrow('first week starts')
        expect(request).not.toHaveBeenCalled()
    })
    const legacyGames = [
        { id: 'legacy-1', nba_game_id: 'FAKE0001', season_year: 2027, week_number: 1,
            game_date: '2026-10-20', home_team: 'NYK', away_team: 'BOS', status: 'Scheduled', stats_synced_at: null },
        { id: 'legacy-2', nba_game_id: 'FAKE0002', season_year: 2027, week_number: 1,
            game_date: '2026-10-21', home_team: 'BOS', away_team: 'LAL', status: 'Scheduled', stats_synced_at: null },
    ]
    const legacySetup = (results: Record<string, unknown> = {}) => {
        const harness = setup()
        const client = fakeClient({
            'nba_games.select': { data: legacyGames, error: null },
            'player_game_stats.select': { count: 0, error: null },
            'nba_games.delete': { data: legacyGames.map(({ id }) => ({ id })), error: null },
            ...results,
        })
        const from = harness.context.supabase.from
        harness.context.supabase.from = (table) => ['nba_games', 'player_game_stats'].includes(table) ? client.from(table) : from(table)
        const rpc = harness.context.supabase.rpc
        harness.context.supabase.rpc = vi.fn(async (name, args) => client.calls.some((call) => call.table === 'nba_games' && call.op === 'delete')
            ? rpc(name, args) : { data: { applied: false }, error: null })
        harness.context.fake = createFakeUpstreamServer({ seasonYear: 2027 })
        harness.context.season = { ...season, season_year: 2027 }
        return { ...harness, client }
    }
    it('removes only superseded current-season legacy fake games before importing the complete calendar', async () => {
        const unrelated = { ...legacyGames[0], id: 'real', nba_game_id: '0022600999' }
        const priorSeason = { ...legacyGames[0], id: 'historical', season_year: 2026 }
        const wrongDate = { ...legacyGames[0], id: 'other-date', game_date: '2026-10-22' }
        const { context, client, dates } = legacySetup({
            'nba_games.select': { data: [...legacyGames, unrelated, priorSeason, wrongDate], error: null },
        })
        await completeSoakSeason(context)
        const deleted = client.calls.filter((call) => call.op === 'delete')
        expect(deleted).toEqual([{ table: 'nba_games', op: 'delete', args: [] }])
        expect(client.calls).toContainEqual({ table: 'nba_games', op: 'in', args: ['id', ['legacy-1', 'legacy-2']] })
        expect(client.calls).toContainEqual({ table: 'nba_games', op: 'eq', args: ['season_year', 2027] })
        expect(client.calls).toContainEqual({ table: 'nba_games', op: 'eq', args: ['status', 'Scheduled'] })
        expect(dates).toHaveLength(52)
    })
    it('does not delete a legacy game with stored stats or mark the boundary ready', async () => {
        const { context, client, rpc } = legacySetup({ 'player_game_stats.select': { count: 1, error: null } })
        await expect(completeSoakSeason(context)).rejects.toThrow('legacy fake games have stored stats')
        expect(client.calls.some((call) => call.op === 'delete')).toBe(false)
        expect(rpc).not.toHaveBeenCalled()
    })
    it('fails closed if a legacy fixture changes during its guarded removal', async () => {
        const { context, rpc } = legacySetup({ 'nba_games.delete': { data: [{ id: 'legacy-1' }], error: null } })
        await expect(completeSoakSeason(context)).rejects.toThrow('legacy fake games changed during removal')
        expect(rpc).not.toHaveBeenCalled()
    })
    it('keeps completion evidence and current fake-calendar games out of legacy removal', async () => {
        const completed = legacySetup({ 'nba_games.select': { data: [{ ...legacyGames[0], status: 'Final', stats_synced_at: '2026-10-21T12:00:00Z' }], error: null } })
        await expect(completeSoakSeason(completed.context)).rejects.toThrow('have completion evidence')
        expect(completed.client.calls.some((call) => call.op === 'delete')).toBe(false)
        const present = legacySetup()
        present.context.fake.state.games.set('FAKE0001', { ...present.context.fake.state.games.values().next().value, gameId: 'FAKE0001', gameDate: '2026-10-20' })
        present.client.calls.length = 0
        await expect(completeSoakSeason(present.context)).rejects.toThrow('changed during removal')
        expect(present.client.calls).toContainEqual({ table: 'nba_games', op: 'in', args: ['id', ['legacy-2']] })
    })
    it('handles synthetic legacy ID replacements and the old annual seed without touching other games', async () => {
        const alias = { ...legacyGames[0], nba_game_id: '002FAKE0001' }
        const replacement = legacySetup({ 'nba_games.select': { data: [alias], error: null },
            'nba_games.delete': { data: [{ id: alias.id }], error: null } })
        await completeSoakSeason(replacement.context)
        expect(replacement.client.calls).toContainEqual({ table: 'nba_games', op: 'in', args: ['id', [alias.id]] })
        const annual = { ...legacyGames[0], id: 'annual', nba_game_id: 'FAKE203001', season_year: 2030,
            game_date: '2029-10-20', home_team: 'BOS', away_team: 'UTA' }
        const next = legacySetup({ 'nba_games.select': { data: [annual], error: null },
            'nba_games.delete': { data: [{ id: annual.id }], error: null } })
        next.context.season = season
        next.context.fake = createFakeUpstreamServer({ seasonYear: 2030 })
        await completeSoakSeason(next.context)
        expect(next.client.calls).toContainEqual({ table: 'nba_games', op: 'in', args: ['id', ['annual']] })
    })
    it('reports the RPC payload, scoped readiness counts, timestamps and grace reference on a declined boundary', async () => {
        const seasonId = '00000000-0000-4000-8000-000000000001'
        const leagueId = '00000000-0000-4000-8000-000000000002'
        const readiness = { phase: 'playoff_final', matchupCount: 1, finalizedCount: 0,
            latestFinalizedAt: null, certificateCount: 0 }
        boundaryQueries.read.mockReturnValueOnce([{ readiness }])
        const rpc = vi.fn(async () => ({ data: { applied: false, reason: 'fixture-not-ready' }, error: null }))
        const error = await rolloverSoakSeason({ supabase: { rpc }, leagueId,
            season: { ...season, id: seasonId }, env: { supabaseUrl: 'http://127.0.0.1:54321' } }).catch((value: Error) => value)
        expect(error).toBeInstanceOf(Error)
        const details = JSON.parse((error as Error).message.split('diagnostics=')[1]) as { rpcPayload: unknown; readiness: unknown; referenceAt: string }
        expect(details.rpcPayload).toEqual({ applied: false, reason: 'fixture-not-ready' })
        expect(details.readiness).toEqual(readiness)
        expect(Date.parse(details.referenceAt) - Date.now()).toBeGreaterThan(48 * 60 * 60 * 1000)
        expect(boundaryQueries.read).toHaveBeenCalledWith('local', 'soak boundary readiness', expect.stringContaining('private.score_week_certificates'))
        const sql = boundaryQueries.read.mock.calls.at(-1)![2] as string
        expect(sql).toContain(seasonId)
        expect(sql).toContain(leagueId)
        expect(sql).toContain('max(finalized_at)')
    })
    it('keeps the original decline and payload when local readiness diagnostics fail', async () => {
        boundaryQueries.read.mockImplementationOnce(() => { throw new Error('local SQL unavailable') })
        const rpc = vi.fn(async () => ({ data: { applied: false }, error: null }))
        await expect(rolloverSoakSeason({ supabase: { rpc },
            leagueId: '00000000-0000-4000-8000-000000000002',
            season: { ...season, id: '00000000-0000-4000-8000-000000000001' },
            env: { supabaseUrl: 'http://127.0.0.1:54321' },
        })).rejects.toThrow('"rpcPayload":{"applied":false}')
        expect(boundaryQueries.read).toHaveBeenCalled()
    })
    it('reports RPC errors with parsed JSON readiness facts', async () => {
        boundaryQueries.read.mockReturnValueOnce([{ readiness: JSON.stringify({ finalizedCount: 95, certificateCount: 19, latestFinalizedAt: '2026-10-13T12:00:00Z' }) }])
        const rpc = vi.fn(async () => ({ data: null, error: { code: 'PT409', message: 'Game inputs changed. Retry.' } }))
        const error = await rolloverSoakSeason({ supabase: { rpc },
            leagueId: '00000000-0000-4000-8000-000000000002',
            season: { ...season, id: '00000000-0000-4000-8000-000000000001' },
            env: { supabaseUrl: 'http://127.0.0.1:54321' },
        }).catch((value: Error) => value)
        expect(error).toBeInstanceOf(Error)
        const details = JSON.parse((error as Error).message.split('diagnostics=')[1]) as { rpcPayload: unknown; rpcError: unknown; readiness: unknown }
        expect(details.rpcPayload).toBeNull()
        expect(details.rpcError).toEqual({ code: 'PT409', message: 'Game inputs changed. Retry.' })
        expect(details.readiness).toEqual({ finalizedCount: 95, certificateCount: 19, latestFinalizedAt: '2026-10-13T12:00:00Z' })
    })
    it('does not query a remote stack or accept SQL inputs in diagnostic identifiers', async () => {
        const rpc = vi.fn(async () => ({ data: { applied: false }, error: null }))
        const context = { supabase: { rpc }, leagueId: '00000000-0000-4000-8000-000000000002',
            season: { ...season, id: '00000000-0000-4000-8000-000000000001' }, env: { supabaseUrl: 'https://fixture.invalid' } }
        await expect(rolloverSoakSeason(context)).rejects.toThrow('require the project local stack')
        context.env.supabaseUrl = 'http://127.0.0.1:54321'
        context.season.id = "invalid'; SELECT 1; --"
        await expect(rolloverSoakSeason(context)).rejects.toThrow('require valid league, season and action inputs')
        expect(boundaryQueries.read).not.toHaveBeenCalled()
    })
})

describe('deletePlayersWithReferences', () => {
    it('removes every referencing row before the player rows, children first', async () => {
        const client = fakeClient({
            'players.select': { data: [{ id: 'p1' }, { id: 'p2' }], error: null },
            'roster_players.delete': { error: null, count: 2 },
        })

        const result = await deletePlayersWithReferences(client, { sportsdataIdLike: 'perpetual-%' })

        const deletes = client.calls.filter((c) => c.op === 'delete').map((c) => c.table)
        expect(deletes.at(-1)).toBe('players')
        expect(deletes.slice(0, -1)).toEqual(PLAYER_REFERENCE_TABLES.map((t) => t.table))
        expect(deletes.indexOf('trade_drop_reservations')).toBeLessThan(deletes.indexOf('roster_players'))
        expect(deletes.indexOf('roster_players')).toBeLessThan(deletes.indexOf('players'))
        expect(result.playerIds).toEqual(['p1', 'p2'])
        expect(result.deleted['roster_players.player_id']).toBe(2)
        const inFilters = client.calls.filter((c) => c.op === 'in')
        expect(inFilters.every((c) => JSON.stringify(c.args[1]) === JSON.stringify(['p1', 'p2']))).toBe(true)
    })

    it('touches nothing when no harness players exist', async () => {
        const client = fakeClient({ 'players.select': { data: [], error: null } })
        const result = await deletePlayersWithReferences(client, { sportsdataIdLike: 'perpetual-%' })
        expect(result.playerIds).toEqual([])
        expect(client.calls.some((c) => c.op === 'delete')).toBe(false)
    })

    it('names the table that refused the delete', async () => {
        const client = fakeClient({
            'players.select': { data: [{ id: 'p1' }], error: null },
            'waiver_wire_log.delete': { error: { message: 'boom' }, count: null },
        })
        await expect(deletePlayersWithReferences(client, { sportsdataIdLike: 'x%', label: 'cleanup' }))
            .rejects.toThrow(/cleanup waiver_wire_log\.player_id: boom/)
    })
})

describe('ensureRosterFixture', () => {
    const args = { leagueId: 'L', leagueSeasonId: 'S', memberId: 'M' }

    it('inserts a seeded e2e player when the roster is empty', async () => {
        const client = fakeClient({
            'roster_players.select': { data: null, error: null },
            'players.select': { data: { id: 'e2e-1' }, error: null },
            'roster_players.insert': { error: null },
        })
        const result = await ensureRosterFixture(client, args)
        expect(result).toEqual({ playerId: 'e2e-1', inserted: true })
        const like = client.calls.find((c) => c.table === 'players' && c.op === 'like')
        expect(like?.args).toEqual(['sportsdata_id', 'e2e-player-%'])
        const insert = client.calls.find((c) => c.table === 'roster_players' && c.op === 'insert')
        expect(insert?.args[0]).toMatchObject({ league_id: 'L', league_season_id: 'S', member_id: 'M', player_id: 'e2e-1' })
    })

    it('is a no-op when the member already has a rostered player', async () => {
        const client = fakeClient({ 'roster_players.select': { data: { player_id: 'have' }, error: null } })
        const result = await ensureRosterFixture(client, args)
        expect(result).toEqual({ playerId: 'have', inserted: false })
        expect(client.calls.some((c) => c.op === 'insert')).toBe(false)
    })

    it('fails loudly when the seed has not run', async () => {
        const client = fakeClient({ 'roster_players.select': { data: null, error: null }, 'players.select': { data: null, error: null } })
        await expect(ensureRosterFixture(client, args)).rejects.toThrow(/no seeded player .*e2e:seed/)
    })
})

describe('harness cleanup table list', () => {
    it('lists only tables the migration set still has', async () => {
        const { readdir, readFile } = await import('node:fs/promises')
        const dir = 'supabase/migrations'
        const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
        const created = new Set<string>()
        const dropped = new Set<string>()
        for (const file of files) {
            const sql = maskSqlNonCode(await readFile(`${dir}/${file}`, 'utf8'))
            for (const statement of sql.split(';')) {
                const create = statement.match(/^\s*CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?([a-z_]+)/i)
                if (create) { created.add(create[1]); dropped.delete(create[1]) }
                const drop = statement.match(/^\s*DROP TABLE(?: IF EXISTS)?\s+(?:public\.)?([a-z_]+)/i)
                if (drop) dropped.add(drop[1])
            }
        }
        for (const { table } of PLAYER_REFERENCE_TABLES) {
            expect(created.has(table), `${table} was never created`).toBe(true)
            expect(dropped.has(table), `${table} was dropped by a migration`).toBe(false)
        }
    })

    // Review round 2, S9: derive the set of live tables that reference players
    // without ON DELETE from the migrations themselves, so a new plain foreign
    // key to players cannot appear without the cleanup list going red.
    it('covers every live table with a plain foreign key to players', async () => {
        const { readdir, readFile } = await import('node:fs/promises')
        const dir = 'supabase/migrations'
        const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
        const referencing = new Set<string>()
        const dropped = new Set<string>()
        for (const file of files) {
            const sql = await readFile(`${dir}/${file}`, 'utf8')
            let table: string | null = null
            const lines = sql.split('\n').map((raw) => raw.replace(/--.*$/, ''))
            for (let index = 0; index < lines.length; index += 1) {
                const line = lines[index]
                const create = line.match(/CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?([a-z_]+)/i)
                const alter = line.match(/ALTER TABLE(?: ONLY)?(?: IF EXISTS)?\s+(?:public\.)?([a-z_]+)/i)
                if (create) { table = create[1]; dropped.delete(table) }
                else if (alter) table = alter[1]
                const drop = line.match(/^\s*DROP TABLE(?: IF EXISTS)?\s+(?:public\.)?([a-z_]+)/i)
                if (drop) { dropped.add(drop[1]); continue }
                // "REFERENCES players" with or without "(id)"; the ON DELETE clause may
                // sit on the next line. Only CASCADE / SET NULL / SET DEFAULT remove the
                // row automatically; RESTRICT and NO ACTION block the delete like the default.
                if (table && /REFERENCES\s+(?:public\.)?players\b/i.test(line)) {
                    const clause = `${line} ${lines[index + 1] ?? ''}`
                    if (!/ON DELETE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT)/i.test(clause)) referencing.add(table)
                }
            }
        }
        for (const t of dropped) referencing.delete(t)
        const listed = new Set(PLAYER_REFERENCE_TABLES.map((t) => t.table))
        expect([...referencing].sort()).toEqual([...listed].sort())
    })
})

describe('dynasty ranking seed fixtures', () => {
    it('builds synthetic hashtag rows in the high rank band tagged with the e2e player id', async () => {
        const { buildDynastyRankingFixtures, DYNASTY_FIXTURE_RANK_BASE } = await import('./e2e/seed-league.mjs')
        const rows = buildDynastyRankingFixtures([
            { id: 'p1', sportsdata_id: 'e2e-player-001', first_name: 'E2E', last_name: 'Player001', eligible_positions: ['PG'], nba_team: 'ATL' },
            { id: 'p2', sportsdata_id: 'e2e-player-002', first_name: 'E2E', last_name: 'Player002', eligible_positions: ['SG'], nba_team: null },
        ], '2026-09-12T00:00:00.000Z')
        expect(rows.map((r: { source_rank: number }) => r.source_rank)).toEqual([DYNASTY_FIXTURE_RANK_BASE + 1, DYNASTY_FIXTURE_RANK_BASE + 2])
        expect(rows.every((r: { source: string; source_player_id: string }) => r.source === 'hashtagbasketball.com' && r.source_player_id.startsWith('e2e-'))).toBe(true)
        expect(rows[0]).toMatchObject({ player_id: 'p1', source_player_name: 'E2E Player001', source_team: 'ATL', scoring_format: 'overall' })
        expect(rows[1].source_team).toBeNull()
    })
})

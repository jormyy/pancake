import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { assertMatchupGenerationIdempotent } from './soak-support.mjs'
import { prepareSoakSeason } from './harness/season-loop.mjs'

vi.mock('./env.mjs', () => Object.fromEntries([
  'resolvedEnv', 'resolvedTradeEnv', 'describeEndpoint', 'querySupabaseDb', 'requireEnv', 'envValue',
  'runCommand', 'statusFrom', 'cleanMessage', 'localSupabaseStatus', 'writeMarkdownReport',
  'writeReportIfChanged', 'isProductionSupabaseUrl', 'loadEnvFile',
].map(name => [name, vi.fn()])))

const env = { apiBaseUrl: 'http://127.0.0.1:54321/functions/v1/api', e2eAdminSecret: 'local-test' }
const season = { id: 'season', season_year: 2027, playoff_start_week: 2 }
const initial = [
  { id: 'first', league_id: 'league', league_season_id: 'season', week_number: 1, home_member_id: 'a', away_member_id: 'b', home_points: 4 },
  { id: 'second', league_id: 'league', league_season_id: 'season', week_number: 1, home_member_id: 'c', away_member_id: 'd', home_points: 2 },
]

function database(change: (rows: typeof initial) => typeof initial) {
  let rows = structuredClone(initial)
  const requested: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
    requested.push(JSON.parse(String(options.body)))
    rows = change(rows)
    return new Response(JSON.stringify({ ok: true, skipped: true }), { status: 200 })
  }))
  const supabase = {
    from(table: string) {
      const filters: Record<string, unknown> = {}
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => { filters[column] = value; return query },
        order: () => query,
        update: () => query,
        single: async () => ({ data: season, error: null }),
        then(resolve: (result: { data: typeof initial; count: number; error: null }) => unknown) {
          assert.equal(table === 'leagues' ? filters.id : filters.league_id, 'league')
          if (table === 'matchups') assert.equal(filters.league_season_id, 'season')
          return Promise.resolve({ data: structuredClone(rows), count: table === 'league_members' ? 4 : rows.length, error: null }).then(resolve)
        },
      }
      return query
    },
  }
  return { supabase, requested }
}

afterEach(() => vi.unstubAllGlobals())

test('the soak accepts a skipped generation response when the schedule stays unchanged', async () => {
  const { supabase, requested } = database(rows => rows)
  assert.deepEqual(await assertMatchupGenerationIdempotent(supabase, env, 'league'), [])
  await prepareSoakSeason({ supabase, env, leagueId: 'league', season })
  assert.deepEqual(requested, [{ force: false, leagueId: 'league' }, { leagueId: 'league', force: false }])
})

test.each([{ id: 'replacement' }, { home_points: 0 }, { home_member_id: 'other' }])('the idempotence check catches changed rows with the same count: %j', async change => {
  const { supabase } = database(rows => [{ ...rows[0], ...change }, rows[1]])
  assert.ok((await assertMatchupGenerationIdempotent(supabase, env, 'league')).some((failure: string) => failure.includes('schedule changed')))
})

test('season preparation rejects a skipped response that replaces the existing schedule', async () => {
  const { supabase } = database(rows => [{ ...rows[0], id: 'replacement' }, rows[1]])
  await assert.rejects(prepareSoakSeason({ supabase, env, leagueId: 'league', season }), /Existing schedule changed/)
})

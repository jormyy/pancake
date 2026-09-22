import { expect, it, vi } from 'vitest'
import { withLocalLatencyFixture } from './e2e/data-latency-fixture.mjs'

const user1 = '11111111-1111-4111-8111-111111111111'
const user2 = '22222222-2222-4222-8222-222222222222'
const leagueId = '33333333-3333-4333-8333-333333333333'
const state = { leagueId, users: [
  { id: user1, email: 'pancake-e2e-fixture-1@example.com' },
  { id: user2, email: 'pancake-e2e-fixture-2@example.com' },
] }

const fixture = ({ existing = false, cleanupFails = false, foreignMember = false } = {}) => {
  let row: Record<string, unknown> | null = existing ? { id: 'existing-matchup' } : null
  const mutations: { operation: string, filters: Record<string, unknown> }[] = []
  const from = vi.fn((table: string) => {
    let operation = 'read'
    let inserted: Record<string, unknown>
    const filters: Record<string, unknown> = {}
    const result = () => {
      if (table === 'league_seasons') return { data: { id: 'season-after-rollover' }, error: null }
      if (table === 'league_members') return { data: [
        { id: 'member1', user_id: user1 }, { id: 'member2', user_id: foreignMember ? 'foreign-user' : user2 },
      ], error: null }
      if (operation === 'insert') { row = inserted; mutations.push({ operation, filters }); return { error: null } }
      if (operation === 'delete') {
        mutations.push({ operation, filters })
        if (cleanupFails) return { error: new Error('fixture cleanup failed') }
        const removed = row ? [{ id: row.id }] : []
        row = null
        return { data: removed, error: null }
      }
      return { data: row, error: null }
    }
    const query = {
      select: () => query, order: () => query, limit: () => query,
      eq: (key: string, value: unknown) => { filters[key] = value; return query },
      insert: (value: Record<string, unknown>) => { operation = 'insert'; inserted = value; return query },
      delete: () => { operation = 'delete'; return query },
      single: async () => result(), maybeSingle: async () => result(),
      then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve),
    }
    return query
  })
  return { client: { from }, from, mutations, getRow: () => row }
}

it('measures a real temporary matchup then removes only that exact current-season row', async () => {
  const db = fixture()
  let insertedId: unknown
  const result = await withLocalLatencyFixture({ supabaseUrl: 'http://127.0.0.1:60821', state, client: db.client,
    runBenchmark: async () => {
      const row = db.getRow()!
      expect(row).toMatchObject({ league_id: leagueId, league_season_id: 'season-after-rollover', week_number: 1, home_member_id: 'member1', away_member_id: 'member2' })
      insertedId = row.id
      return 'measured'
    },
  })
  expect(result).toEqual({ fixtureCreated: true, result: 'measured' })
  expect(db.getRow()).toBeNull()
  expect(db.mutations.at(-1)).toEqual({ operation: 'delete', filters: { id: insertedId, league_id: leagueId, league_season_id: 'season-after-rollover' } })
})

it('preserves existing matchup data', async () => {
  const db = fixture({ existing: true })
  const runBenchmark = vi.fn(async () => 'measured')
  expect(await withLocalLatencyFixture({ supabaseUrl: 'http://localhost:60821', state, client: db.client, runBenchmark })).toEqual({ fixtureCreated: false, result: 'measured' })
  expect(runBenchmark).toHaveBeenCalledOnce()
  expect(db.getRow()).toEqual({ id: 'existing-matchup' })
  expect(db.mutations).toEqual([])
})

it('cleans up after a failed benchmark and preserves its failure', async () => {
  const db = fixture()
  await expect(withLocalLatencyFixture({ supabaseUrl: 'http://127.0.0.1:60821', state, client: db.client,
    runBenchmark: async () => { throw new Error('measurement rejected') },
  })).rejects.toThrow('measurement rejected')
  expect(db.getRow()).toBeNull()
})

it('fails when fixture cleanup fails even if measurements pass', async () => {
  const db = fixture({ cleanupFails: true })
  await expect(withLocalLatencyFixture({ supabaseUrl: 'http://127.0.0.1:60821', state, client: db.client,
    runBenchmark: async () => 'measured',
  })).rejects.toThrow('cleanup failed')
})

it.each(['https://ceeytbfmwsnzalxlkalc.supabase.co', 'http://127.0.0.1.example.com', 'https://127.0.0.1', 'http://localhost/remote'])(
  'rejects %s before any database query', async (supabaseUrl) => {
    const db = fixture()
    const runBenchmark = vi.fn()
    await expect(withLocalLatencyFixture({ supabaseUrl, state, client: db.client, runBenchmark })).rejects.toThrow('isolated loopback')
    expect(db.from).not.toHaveBeenCalled()
    expect(runBenchmark).not.toHaveBeenCalled()
  },
)

it('rejects mismatched seed membership without inserting or measuring', async () => {
  const db = fixture({ foreignMember: true })
  const runBenchmark = vi.fn()
  await expect(withLocalLatencyFixture({ supabaseUrl: 'http://127.0.0.1:60821', state, client: db.client, runBenchmark })).rejects.toThrow('do not match the synthetic seed users')
  expect(db.mutations).toEqual([])
  expect(runBenchmark).not.toHaveBeenCalled()
})

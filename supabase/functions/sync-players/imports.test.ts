import { strict as assert } from 'node:assert'

for (const [name, value] of Object.entries({
  SUPABASE_URL: 'http://database.invalid',
  PANCAKE_SUPABASE_SECRET_KEY: 'fixture-key',
  PANCAKE_EDGE_INTERNAL_TOKEN: 'fixture-internal-token',
  EDGE_FUNCTION_INTERNAL_TOKEN: 'fixture-internal-token',
  ESPN_SITE_BASE_URL: 'http://espn.invalid/api',
  NBA_CDN_BASE_URL: 'http://nba.invalid/static/json',
  SLEEPER_BASE_URL: 'http://sleeper.invalid/v1',
})) Deno.env.set(name, value)

type Handler = (request: Request) => Promise<Response>
const handlers = new Map<string, Handler>()
const serveDescriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
try {
  for (const source of ['espn', 'sleeper']) {
    Deno.env.set('PLAYER_SYNC_SOURCE', source)
    Object.defineProperty(Deno, 'serve', { value: (handler: Handler) => { handlers.set(source, handler) } })
    await import(`./index.ts?source=${source}`)
  }
} finally {
  Object.defineProperty(Deno, 'serve', serveDescriptor)
}

const players = Array.from({ length: 634 }, (_, index) => ({
  provider_id: String(1000 + index), first_name: 'Fixture', last_name: `Player${index}`,
}))
const conflictPlayerId = '00000000-0000-4000-8000-000000000123'

async function runSync(source: string, conflicts: Set<string>, otherError = false, indexAction?: string) {
  const originalFetch = globalThis.fetch
  const originalLog = console.log
  const originalError = console.error
  const imports: string[][] = []
  const imported: string[] = []
  const runs: { status: string; error?: string; rows_affected?: number }[] = []
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.hostname === 'espn.invalid') {
      if (url.pathname === '/api/teams') return Response.json({ sports: [{ leagues: [{ teams:
        Array.from({ length: 28 }, (_, index) => ({ team: { id: String(index), abbreviation: 'BOS' } })),
      }] }] })
      const team = url.pathname.match(/^\/api\/teams\/(\d+)\/roster$/)
      if (team) return Response.json({ athletes: players.filter((_, index) => index % 28 === Number(team[1])).map((player) => ({
        id: player.provider_id, firstName: player.first_name, lastName: player.last_name,
        position: { abbreviation: 'PG' }, status: { type: 'active' }, experience: { years: 1 },
      })) })
      if (url.pathname === '/api/injuries') return Response.json({ injuries: [] })
      if (url.pathname === '/api/news') return Response.json({ articles: [] })
    }
    if (url.hostname === 'sleeper.invalid' && url.pathname === '/v1/players/nba') return Response.json(Object.fromEntries(players.map((player) => [player.provider_id, {
      ...player, player_id: player.provider_id, sport: 'nba', position: 'PG', team: 'BOS', status: 'Active', years_exp: 1,
    }])))
    if (url.hostname === 'nba.invalid' && url.pathname === '/static/json/staticData/playerIndex.json') return Response.json({ resultSets: [{
      headers: ['PERSON_ID', 'PLAYER_FIRST_NAME', 'PLAYER_LAST_NAME', 'ROSTER_STATUS'], rowSet: indexAction ? [['nba-index-id', 'Index', 'Candidate', 1]] : [],
    }] })
    assert.equal(url.hostname, 'database.invalid', `Unexpected request ${url.hostname}${url.pathname}`)
    if (url.pathname === '/rest/v1/sync_runs') {
      if (request.method === 'POST') return Response.json({ id: 'fixture-run' })
      assert.equal(request.method, 'PATCH')
      runs.push(await request.json())
      return Response.json({})
    }
    if (url.pathname === '/rest/v1/players') return Response.json(indexAction ? [{ id: 'index-candidate', display_name: 'Index Candidate', nba_id: null }] : [])
    if (url.pathname === '/rest/v1/rpc/merge_duplicate_players') return Response.json(null)
    assert.equal(url.pathname, '/rest/v1/rpc/resolve_player_imports_atomic')
    const body = await request.json() as { p_source: string; p_records: { provider_id: string }[] }
    if (body.p_source === 'nba_index') return Response.json({ results: [{ index: 0, player_id: null, action: indexAction }], stale_draft_numbers_cleared: 0 })
    assert.equal(body.p_source, source)
    const ids = body.p_records.map((row) => row.provider_id)
    imports.push(ids)
    if (ids.some((id) => conflicts.has(id))) return Response.json({ code: '23514', message: otherError
      ? 'Player metadata is invalid.' : `Conflicting provider identity for player ${conflictPlayerId}` }, { status: 400 })
    imported.push(...ids)
    return Response.json({ results: ids.map((id, index) => ({ index, player_id: `player-${id}`, action: 'updated' })), stale_draft_numbers_cleared: 0 })
  }
  try {
    console.log = () => undefined
    console.error = () => undefined
    const response = await handlers.get(source)!(new Request('http://function.invalid/sync-players', {
      method: 'POST', headers: { 'x-internal-function-token': 'fixture-internal-token' },
    }))
    return { response, imports, imported, runs }
  } finally {
    globalThis.fetch = originalFetch
    console.log = originalLog
    console.error = originalError
  }
}

for (const source of ['espn', 'sleeper']) {
  Deno.test(`${source}: one identity conflict imports healthy records and marks the run failed`, async () => {
    const providerId = '1123'
    const result = await runSync(source, new Set([providerId]))
    assert.equal(result.imported.length, 633)
    assert.equal(new Set(result.imported).size, 633)
    assert.ok(!result.imported.includes(providerId))
    assert.ok(result.imports.length <= 20, `${result.imports.length} RPCs exceed the bounded split workload`)
    assert.equal(result.response.status, 500)
    assert.equal(result.runs.at(-1)?.status, 'failed')
    assert.equal(result.runs.at(-1)?.rows_affected, result.imported.length)
    assert.match(result.runs.at(-1)?.error ?? '', new RegExp(`provider ${providerId}.*${conflictPlayerId}`))
    assert.match(result.runs.at(-1)?.error ?? '', /sync-players had 1 failure\(s\)/)
    console.log(`${source}: ${result.imports.length} import RPCs, ${result.imported.length} healthy records imported, 1 conflict reported, run failed`)
  })

  Deno.test(`${source}: a non-identity error still fails the chunk without splitting`, async () => {
    const result = await runSync(source, new Set(['1123']), true)
    assert.equal(result.imports.length, 2)
    assert.equal(result.imported.length, 134)
    assert.equal(result.response.status, 500)
    assert.equal(result.runs.at(-1)?.status, 'failed')
    assert.equal(result.runs.at(-1)?.rows_affected, result.imported.length)
    assert.match(result.runs.at(-1)?.error ?? '', /import chunk 0: Resolve .* players: Player metadata is invalid/)
  })

  Deno.test(`${source}: multiple identity conflicts each report their provider ID without duplicate imports`, async () => {
    const conflicts = new Set(['1123', '1523'])
    const result = await runSync(source, conflicts)
    assert.equal(result.imported.length, 632)
    assert.equal(new Set(result.imported).size, 632)
    for (const id of conflicts) {
      assert.ok(!result.imported.includes(id))
      assert.match(result.runs.at(-1)?.error ?? '', new RegExp(`provider ${id}.*${conflictPlayerId}`))
    }
    assert.ok(result.imports.length <= 38, `${result.imports.length} RPCs exceed the bounded split workload`)
    assert.equal(result.response.status, 500)
    assert.equal(result.runs.at(-1)?.status, 'failed')
    assert.equal(result.runs.at(-1)?.rows_affected, result.imported.length)
    assert.match(result.runs.at(-1)?.error ?? '', /sync-players had 2 failure\(s\)/)
  })

  Deno.test(`${source}: healthy chunks keep the existing RPC volume and successful run status`, async () => {
    const result = await runSync(source, new Set())
    assert.equal(result.imports.length, 2)
    assert.equal(result.imported.length, 634)
    assert.equal(new Set(result.imported).size, 634)
    assert.equal(result.response.status, 200)
    assert.equal(result.runs.at(-1)?.status, 'success')
    assert.equal(result.runs.at(-1)?.rows_affected, 634)
  })
}

for (const action of ['missing', 'stale', 'ambiguous']) {
  Deno.test(`NBA index reports an unresolved ${action} receipt as a failed sync`, async () => {
    const result = await runSync('sleeper', new Set(), false, action)
    assert.equal(result.response.status, 500)
    assert.equal(result.runs.at(-1)?.status, 'failed')
    assert.match(result.runs.at(-1)?.error ?? '', new RegExp(`nba-index-id.*${action}`))
  })
}

import { strict as assert } from 'node:assert'

for (const [key, value] of Object.entries({
  SUPABASE_URL: 'http://database.invalid', PANCAKE_SUPABASE_SECRET_KEY: 'fixture-key',
  PANCAKE_EDGE_INTERNAL_TOKEN: 'fixture-token', PLAYER_SYNC_SOURCE: 'espn',
  ESPN_SITE_BASE_URL: 'http://espn.invalid', NBA_CDN_BASE_URL: 'http://nba.invalid',
  SLEEPER_BASE_URL: 'http://sleeper.invalid',
  ESPN_CAREER_BASE_URL: 'http://career.invalid',
})) Deno.env.set(key, value)

type Handler = (request: Request) => Promise<Response>
let handler: Handler
const descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
Object.defineProperty(Deno, 'serve', { value: (callback: Handler) => { handler = callback } })
try {
  await import('./index.ts')
} finally {
  Object.defineProperty(Deno, 'serve', descriptor)
}

const codes = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GS', 'HOU', 'IND', 'LAC', 'LAL', 'MEM',
  'MIA', 'MIL', 'MIN', 'NO', 'NY', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SA', 'TOR', 'UTAH', 'WSH']
const healthyInjuries = { injuries: [{ injuries: [{ status: 'Out', athlete: { displayName: 'Team0 Player0' } }] }] }

async function sync(body: unknown = {}, injuries: unknown = healthyInjuries, injuryStatus = 200, earlierWorkMs = 0, sleeperUnavailable = false, identityBridge = false, singleOwner = false) {
  const originalFetch = globalThis.fetch
  const originalNow = performance.now.bind(performance)
  const nowDescriptor = Object.getOwnPropertyDescriptor(performance, 'now')
  let elapsed = 0
  Object.defineProperty(performance, 'now', { configurable: true, value: () => originalNow() + elapsed })
  const requests: URL[] = []
  const imports: { metadata: Record<string, unknown> }[] = []
  const runs: Record<string, unknown>[] = []
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    requests.push(url)
    if (url.hostname === 'espn.invalid') {
      if (url.pathname === '/teams') return Response.json({ sports: [{ leagues: [{ teams: codes.map((abbreviation, index) => ({ team: { id: String(index), abbreviation } })) }] }] })
      const team = url.pathname.match(/^\/teams\/(\d+)\/roster$/)?.[1]
      if (team) return Response.json({ athletes: Array.from({ length: 12 }, (_, index) => ({
        id: identityBridge && team === '0' && index === 0 ? '800' : `${team}-${index}`, firstName: identityBridge && team === '0' && index === 0 ? 'Bridge' : `Team${team}`, lastName: identityBridge && team === '0' && index === 0 ? 'Person' : `Player${index}`,
        experience: { years: 1 }, dateOfBirth: '1998-09-02T07:00Z', position: { abbreviation: 'PG' }, status: { type: 'active' },
      })) })
      if (url.pathname === '/injuries') return Response.json(injuries, { status: injuryStatus })
      if (url.pathname === '/news') { elapsed = earlierWorkMs; return Response.json({ articles: [] }) }
    }
    if (url.hostname === 'nba.invalid') return Response.json({ resultSets: [{
      headers: ['PERSON_ID', 'PLAYER_FIRST_NAME', 'PLAYER_LAST_NAME', 'ROSTER_STATUS', 'TEAM_ABBREVIATION'], rowSet: identityBridge ? [['900', 'Bridge', 'Person', 1, 'ATL']] : [],
    }] })
    if (url.hostname === 'career.invalid') return Response.json({ unavailable: true })
    if (url.hostname === 'sleeper.invalid') return new Response(null, { status: 503 })
    assert.equal(url.hostname, 'database.invalid', url.href)
    if (url.pathname === '/rest/v1/sync_runs') {
      runs.push(await request.json())
      return Response.json(request.method === 'POST' ? { id: 'run' } : {})
    }
    if (url.pathname === '/rest/v1/rpc/link_player_sources_atomic') return Response.json({ results: [{ index: 0, player_id: 'bridge', action: 'updated' }] })
    if (url.pathname === '/rest/v1/rpc/resolve_player_imports_atomic') {
      const args = await request.json()
      if (args.p_source === 'espn_release') return Response.json({ released: [], held: { unproven: [], unclaimed: [] } })
      assert.equal(args.p_source, 'espn')
      imports.push(...args.p_records)
      return Response.json({ stale_draft_numbers_cleared: 0, results: args.p_records.map((row: { provider_id: string }, index: number) => ({ index, player_id: row.provider_id, action: 'updated' })) })
    }
    if (url.pathname === '/rest/v1/rpc/complete_player_career_base_atomic') return Response.json(false)
    if (url.pathname === '/rest/v1/rpc/claim_player_career_base_atomic') return Response.json(true)
    if (url.pathname === '/rest/v1/rpc/merge_duplicate_players') return Response.json(0)
    if (url.pathname === '/rest/v1/roster_players') return Response.json([])
    assert.equal(url.pathname, '/rest/v1/players')
    if (request.method === 'PATCH') return Response.json([{ id: url.searchParams.get('id')?.slice(3) }])
    return Response.json([
      ...(identityBridge ? [{ id: 'bridge', display_name: 'Bridge Person', nba_id: '900', espn_id: null, nba_team: singleOwner ? 'BOS' : null, career_regular_season_games: 100, career_games_base: 100 }, ...(singleOwner ? [] : [{ id: 'legacy', display_name: 'Bridge Person', nba_id: null, espn_id: null, sleeper_id: '700', nba_team: null, career_regular_season_games: 100, career_games_base: 100 }])] : []),
      { id: 'rookie', display_name: 'Unknown Rookie', espn_id: 'rookie', nba_id: null, nba_team: 'BOS', years_exp: 0, career_regular_season_games: 0, sleeper_id: sleeperUnavailable ? null : 'fixture-rookie', position: 'G', career_games_base: 0, career_games_base_attempted_at: null, injury_status: 'Out' },
      { id: 'veteran', display_name: 'Unknown Veteran', espn_id: 'veteran', nba_id: null, nba_team: 'BOS', years_exp: 10, career_regular_season_games: null, sleeper_id: 'fixture-veteran', position: 'G', career_games_base: null, career_games_base_attempted_at: null, injury_status: null },
    ])
  }
  try {
    const response = await handler!(new Request('http://function.invalid', {
      method: 'POST', headers: { 'x-internal-function-token': 'fixture-token' }, body: JSON.stringify(body),
    }))
    return { response, result: await response.json(), requests, imports, runs }
  } finally {
    globalThis.fetch = originalFetch
    if (nowDescriptor) Object.defineProperty(performance, 'now', nowDescriptor)
    else Reflect.deleteProperty(performance, 'now')
  }
}

Deno.test('sync-players with the old injuries mode runs every full-sync step', async () => {
  const result = await sync({ mode: 'injuries' })
  assert.equal(result.response.status, 200)
  assert.ok(result.imports.every(row => row.metadata.birthdate === '1998-09-02'))
  assert.equal(result.imports.length, 360)
  assert.equal(result.result.updated, 360)
  assert.equal(result.result.careerUnverified, 1)
  assert.deepEqual(result.result.rosterRefreshSkipped, ['NBA roster has fewer than 350 active players', 'NBA roster does not cover all 30 teams'])
  assert.ok(!result.requests.some(url => url.pathname === '/rest/v1/rpc/complete_player_roster_cycle_atomic'))
  for (const path of ['/teams', '/news', '/staticData/playerIndex.json', '/athletes/veteran/stats']) {
    assert.ok(result.requests.some(url => url.pathname === path), path)
  }
  assert.equal(result.runs[0].function_name, 'sync-players')
  assert.equal(result.runs.at(-1)?.status, 'success')
})

for (const [label, injuries, status] of [
  ['malformed entry', { injuries: [{ injuries: [healthyInjuries.injuries[0].injuries[0], { status: 'Out' }] }] }, 200],
  ['HTTP 500', {}, 500],
  ['empty injuries', { injuries: [] }, 200],
] as const) {
  Deno.test(`full sync imports rosters with an injury warning after ${label}`, async () => {
    const result = await sync({}, injuries, status)
    assert.equal(result.response.status, 200)
    assert.equal(result.result.ok, true)
    assert.equal(result.result.failure, null)
    assert.equal(result.result.injuryWarnings, 1)
    assert.equal(result.result.careerUnverified, 1)
    assert.equal(result.imports.length, 360)
    assert.ok(result.imports.every(row => !Object.hasOwn(row.metadata, 'injury_status')))
    assert.equal(result.runs.at(-1)?.status, 'success')
    assert.equal(result.runs.at(-1)?.rows_affected, 360)
  })
}

Deno.test('earlier sync work can exhaust the career base lookup budget without claiming a player', async () => {
  const result = await sync({}, healthyInjuries, 200, 120000)
  assert.equal(result.response.status, 200)
  assert.ok(!result.requests.some(url => url.pathname === '/rest/v1/rpc/claim_player_career_base_atomic'))
})

Deno.test('a provider 503 defers identity refresh without failing the complete worker', async () => {
  const result = await sync({}, healthyInjuries, 200, 0, true)
  assert.equal(result.response.status, 200)
  assert.equal(result.result.identityRefreshDeferred, true)
  assert.equal(result.result.failure, null)
  assert.equal(result.runs.at(-1)?.status, 'success')
})

Deno.test('a corroborated identity bridge precedes full ESPN imports and reuses the NBA response', async () => {
  const result = await sync({}, healthyInjuries, 200, 0, false, true)
  assert.equal(result.response.status, 200)
  assert.equal(result.result.identityBridges, 1)
  const bridge = result.requests.findIndex(url => url.pathname.endsWith('/link_player_sources_atomic'))
  const imported = result.requests.findIndex(url => url.pathname.endsWith('/resolve_player_imports_atomic'))
  assert.ok(bridge >= 0 && bridge < imported)
  assert.equal(result.requests.filter(url => url.hostname === 'nba.invalid').length, 1)
})

Deno.test('a known NBA owner is linked before an ESPN team change can create a duplicate', async () => {
  const result = await sync({}, healthyInjuries, 200, 0, false, true, true)
  assert.equal(result.response.status, 200)
  assert.equal(result.result.identityBridges, 1)
  const bridge = result.requests.findIndex(url => url.pathname.endsWith('/link_player_sources_atomic'))
  const imported = result.requests.findIndex(url => url.pathname.endsWith('/resolve_player_imports_atomic'))
  assert.ok(bridge >= 0 && bridge < imported)
})

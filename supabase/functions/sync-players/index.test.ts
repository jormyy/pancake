import { strict as assert } from 'node:assert'

for (const [key, value] of Object.entries({
  SUPABASE_URL: 'http://database.invalid', PANCAKE_SUPABASE_SECRET_KEY: 'fixture-key',
  PANCAKE_EDGE_INTERNAL_TOKEN: 'fixture-token', PLAYER_SYNC_SOURCE: 'espn',
  ESPN_SITE_BASE_URL: 'http://espn.invalid', NBA_CDN_BASE_URL: 'http://nba.invalid',
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

async function sync(body: unknown = {}, injuries: unknown = healthyInjuries, injuryStatus = 200) {
  const originalFetch = globalThis.fetch
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
        id: `${team}-${index}`, firstName: `Team${team}`, lastName: `Player${index}`,
        experience: { years: 1 }, position: { abbreviation: 'PG' }, status: { type: 'active' },
      })) })
      if (url.pathname === '/injuries') return Response.json(injuries, { status: injuryStatus })
      if (url.pathname === '/news') return Response.json({ articles: [] })
    }
    if (url.hostname === 'nba.invalid') return Response.json({ resultSets: [{
      headers: ['PERSON_ID', 'PLAYER_FIRST_NAME', 'PLAYER_LAST_NAME', 'ROSTER_STATUS'], rowSet: [],
    }] })
    if (url.hostname === 'career.invalid') return Response.json({ unavailable: true })
    assert.equal(url.hostname, 'database.invalid', url.href)
    if (url.pathname === '/rest/v1/sync_runs') {
      runs.push(await request.json())
      return Response.json(request.method === 'POST' ? { id: 'run' } : {})
    }
    if (url.pathname === '/rest/v1/rpc/resolve_player_imports_atomic') {
      const args = await request.json()
      if (args.p_source === 'espn_release') return Response.json({ released: [], held: { unproven: [], unclaimed: [] } })
      assert.equal(args.p_source, 'espn')
      imports.push(...args.p_records)
      return Response.json({ stale_draft_numbers_cleared: 0, results: args.p_records.map((row: { provider_id: string }, index: number) => ({ index, player_id: row.provider_id, action: 'updated' })) })
    }
    if (url.pathname === '/rest/v1/rpc/claim_player_career_prior_atomic') return Response.json(true)
    if (url.pathname === '/rest/v1/rpc/merge_duplicate_players') return Response.json(0)
    if (url.pathname === '/rest/v1/roster_players') return Response.json([])
    assert.equal(url.pathname, '/rest/v1/players')
    if (request.method === 'PATCH') return Response.json([{ id: url.searchParams.get('id')?.slice(3) }])
    return Response.json([
      { id: 'rookie', display_name: 'Unknown Rookie', espn_id: 'rookie', nba_id: null, nba_team: 'BOS', years_exp: 0, career_regular_season_games: 0, career_games_prior: 0, career_games_prior_checked_at: null, injury_status: 'Out' },
      { id: 'veteran', display_name: 'Unknown Veteran', espn_id: 'veteran', nba_id: null, nba_team: 'BOS', years_exp: 10, career_regular_season_games: null, career_games_prior: null, career_games_prior_checked_at: null, injury_status: null },
    ])
  }
  try {
    const response = await handler!(new Request('http://function.invalid', {
      method: 'POST', headers: { 'x-internal-function-token': 'fixture-token' }, body: JSON.stringify(body),
    }))
    return { response, result: await response.json(), requests, imports, runs }
  } finally {
    globalThis.fetch = originalFetch
  }
}

Deno.test('sync-players with the old injuries mode runs every full-sync step', async () => {
  const result = await sync({ mode: 'injuries' })
  assert.equal(result.response.status, 200)
  assert.equal(result.imports.length, 360)
  assert.equal(result.result.updated, 360)
  assert.equal(result.result.careerUnverified, 1)
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

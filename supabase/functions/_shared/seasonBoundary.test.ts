import { strict as assert } from 'node:assert'

let status = 'drafting'
let completed = true
let ready = true
const queries: URLSearchParams[] = []
const calls: { name: string; body: Record<string, unknown> }[] = []
const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async req => {
  const url = new URL(req.url)
  let data: unknown = []
  if (url.pathname === '/rest/v1/league_seasons') {
    queries.push(url.searchParams)
    data = url.searchParams.get('leagues.status')?.includes(status)
      ? [{ id: 'current-season', league_id: 'league', leagues: { status, playoff_start_week: 20 } }] : []
  }
  if (url.pathname === '/rest/v1/drafts') {
    assert.equal(url.searchParams.get('league_season_id'), 'eq.current-season')
    assert.equal(url.searchParams.get('draft_type'), 'eq.snake')
    assert.equal(url.searchParams.get('is_mock'), 'eq.false')
    assert.equal(url.searchParams.get('status'), 'in.(completed,cancelled)')
    data = completed ? [{ id: 'completed-rookie' }] : []
  }
  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    calls.push({ name: url.pathname.split('/').at(-1)!, body: await req.json() })
    data = ready
    if (ready) status = 'active'
  }
  return Response.json(data)
})
Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
const { runSeasonBoundary } = await import('./seasonBoundary.ts')
const reset = () => { status = 'drafting'; completed = true; ready = true; calls.length = 0; queries.length = 0 }

Deno.test('the boundary activates a completed current rookie draft before the NBA season starts', async () => {
  reset()
  const reports = await runSeasonBoundary(new Date('2026-07-01T00:00:00Z'))
  assert.equal(status, 'active')
  assert.deepEqual(reports, [{ leagueId: 'league', actions: ['rookie-league-activated', 'calendar-pending'] }])
  assert.deepEqual(calls, [{ name: 'activate_rookie_draft_league_atomic', body: { p_draft_id: 'completed-rookie' } }])
})

Deno.test('the boundary leaves over-cap rookie rosters drafting and retries when they fit', async () => {
  reset()
  ready = false
  assert.deepEqual(await runSeasonBoundary(), [{ leagueId: 'league', actions: [] }])
  assert.equal(status, 'drafting')
  ready = true
  await runSeasonBoundary()
  assert.equal(status, 'active')
  assert.equal(calls.length, 2)
})

Deno.test('the boundary does not start or activate an unfinished drafting league', async () => {
  reset()
  completed = false
  assert.deepEqual(await runSeasonBoundary(), [{ leagueId: 'league', actions: [] }])
  assert.deepEqual(calls, [])
  assert.equal(status, 'drafting')
})

Deno.test({ name: 'season boundary test server closes', sanitizeOps: false, sanitizeResources: false, fn: () => server.shutdown() })

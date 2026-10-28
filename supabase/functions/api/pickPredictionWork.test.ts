import assert from 'node:assert/strict'

const league = '11111111-1111-4111-8111-111111111111'
const calls: string[] = []
let sourceVersion = 'fixture'
const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async request => {
  const path = new URL(request.url).pathname
  if (path === '/rest/v1/sync_runs') return Response.json({ id: league })
  const name = path.split('/').at(-1)!
  calls.push(name)
  if (name === 'get_pick_prediction_leagues') return Response.json([league])
  if (name === 'get_pick_prediction_inputs') return Response.json({ leagueId: league, seasonYear: 2027,
    sourceVersion, seasonGames: 1, teams: [{ id: league, wins: 0, ties: 0, players: [{ value: 500, age: 27 }] }], games: [],
    picks: [{ id: league, draftYear: 2027, round: 1, originalOwnerId: league, slot: null, bands: { early: 700, mid: 500, late: 300 } }] })
  if (name === 'save_pick_predictions') {
    const body = await request.json()
    assert.equal(body.p_league_id, league)
    assert.equal(body.p_source_version, 'fixture')
    assert.equal(body.p_rows.length, 1)
    assert.equal(body.p_rows[0].value, 500)
    return Response.json(1)
  }
  if (name === 'complete_pick_prediction_refresh') return Response.json(sourceVersion === 'fixture')
  throw new Error(`Unexpected request: ${path}`)
})
Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
Deno.env.set('PANCAKE_EDGE_INTERNAL_TOKEN', 'test')
const { handleApiRoute } = await import('./router.ts')
const request = (authorized: boolean) => new Request('http://localhost/functions/v1/api/trades/pick-values-work', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { 'x-internal-function-token': 'test' } : {}) },
  body: JSON.stringify({ sourceVersion: 'fixture' }),
})

Deno.test('pick refresh route rejects public requests before reading league data', async () => {
  assert.equal((await handleApiRoute(request(false))).status, 401)
  assert.deepEqual(calls, [])
})

Deno.test('pick refresh route saves league predictions before releasing trade re-analysis', async () => {
  const response = await handleApiRoute(request(true))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, result: { updated: 1 } })
  assert.deepEqual(calls, ['get_pick_prediction_leagues', 'get_pick_prediction_inputs', 'save_pick_predictions', 'complete_pick_prediction_refresh'])
})

Deno.test('pick refresh route does not overwrite a newer source snapshot', async () => {
  calls.length = 0
  sourceVersion = 'newer'
  const response = await handleApiRoute(request(true))
  assert.deepEqual(await response.json(), { ok: true, result: { updated: 0 } })
  assert.deepEqual(calls, ['get_pick_prediction_leagues', 'get_pick_prediction_inputs', 'complete_pick_prediction_refresh'])
})

Deno.test({ name: 'pick worker server closes', sanitizeOps: false, sanitizeResources: false, fn: () => server.shutdown() })

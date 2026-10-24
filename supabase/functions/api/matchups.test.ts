import { strict as assert } from 'node:assert'

const calls: Array<{ name: string; body: Record<string, unknown> }> = []
const queries: URLSearchParams[] = []
let reject = false
const postgrest = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (req) => {
  const url = new URL(req.url)
  if (url.pathname === '/rest/v1/league_seasons') {
    queries.push(url.searchParams)
    return Response.json([{ id: 'season-a', league_id: 'league-a', leagues: null }])
  }
  if (!url.pathname.startsWith('/rest/v1/rpc/')) throw new Error('Schedule generation must not load league members')
  calls.push({ name: url.pathname.split('/').at(-1)!, body: await req.json() })
  return reject ? Response.json({ message: 'League is locked' }, { status: 400 }) : Response.json(null)
})
Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(postgrest.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
const { generateMatchups, generateAllMatchups } = await import('./matchups.ts')

Deno.test('matchup generation delegates the schedule to SQL without loading members or sending pairings', async () => {
  calls.length = 0
  await generateMatchups('league-a', 'season-a', 19)
  assert.deepEqual(calls, [{ name: 'replace_regular_season_matchups_atomic', body: {
    p_league_id: 'league-a', p_league_season_id: 'season-a', p_force: false, p_matchups: [],
  } }])
})

Deno.test('matchup generation preserves force and propagates a database rejection', async () => {
  calls.length = 0
  reject = true
  try {
    await assert.rejects(() => generateMatchups('league-a', 'season-a', 19, true), { message: 'League is locked' })
    assert.equal(calls[0].body.p_force, true)
  } finally { reject = false }
})

Deno.test('bulk matchup generation targets current seasons and preserves the requested league', async () => {
  calls.length = 0
  await generateAllMatchups(true, 'league-a')
  assert.equal(queries.at(-1)?.get('league_id'), 'eq.league-a')
  assert.equal(queries.at(-1)?.get('is_current'), 'eq.true')
  assert.equal(calls[0].body.p_league_season_id, 'season-a')
  assert.equal(calls[0].body.p_force, true)
  assert.deepEqual(calls[0].body.p_matchups, [])
})

Deno.test({ name: 'close matchups test server', sanitizeOps: false, sanitizeResources: false, fn: () => postgrest.shutdown() })

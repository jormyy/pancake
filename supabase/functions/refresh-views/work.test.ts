import { strict as assert } from 'node:assert'

const leagueId = '20000000-0000-4000-8000-000000000001'
const seasonId = '20000000-0000-4000-8000-000000000002'
const claimToken = '20000000-0000-4000-8000-000000000007'
const calls: Record<string, unknown>[] = []
let saved = true
let failComplete = false
const backend = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async request => {
  assert.equal(new URL(request.url).pathname, '/rest/v1/rpc/view_refresh_work')
  const body = await request.json()
  calls.push(body)
  if (body.p_params.operation === 'claim') return Response.json([{ leagueId, seasonId, version: 12, claimToken }])
  if (body.p_params.operation === 'complete' && failComplete) return Response.json({ message: 'refresh failed', code: 'XX000' }, { status: 500 })
  return Response.json(saved)
})
Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(backend.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_refresh_fixture')
const { refreshViews } = await import('./work.ts')

Deno.test('screens publish without reading or waiting for any trade', async () => {
  const output = await refreshViews()
  assert.deepEqual(output.result, { completed: 1, failures: [] })
  assert.deepEqual(calls.at(-1), { p_league_id: leagueId, p_params: { seasonId, version: 12, claimToken, operation: 'complete' } })
})

Deno.test('stale screen claims are not counted as successful', async () => {
  saved = false
  assert.equal((await refreshViews()).rowsAffected, 0)
  saved = true
})

Deno.test('screen failures release their own lease for retry', async () => {
  failComplete = true
  const before = calls.length
  const output = await refreshViews()
  assert.equal(output.rowsAffected, 0)
  assert.equal(output.result.failures.length, 1)
  assert.deepEqual(calls.slice(before).map(call => (call.p_params as Record<string, unknown>).operation), ['claim', 'complete', 'fail'])
  failComplete = false
})

Deno.test({ name: 'close refresh test server', sanitizeOps: false, sanitizeResources: false, fn: () => backend.shutdown() })

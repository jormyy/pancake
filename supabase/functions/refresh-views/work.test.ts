import { strict as assert } from 'node:assert'

const leagueId = '20000000-0000-4000-8000-000000000001'
const seasonId = '20000000-0000-4000-8000-000000000002'
const memberId = '20000000-0000-4000-8000-000000000003'
const otherId = '20000000-0000-4000-8000-000000000004'
const tradeId = '20000000-0000-4000-8000-000000000005'
const userId = '20000000-0000-4000-8000-000000000006'
const claimToken = '20000000-0000-4000-8000-000000000007'
const inputs = { leagueId, seasonId, seasonYear: 2027, teams: 2, rosterSize: 20, scoringSettings: { points: 1 }, faabBudget: 100,
  terms: [{ fromMemberId: memberId, toMemberId: otherId, playerId: null, pickId: null, faabAmount: 5 }],
  players: [], replacementPlayers: [], picks: [], inputVersion: 'fixture-input', observedAt: '2026-10-27T12:00:00Z' }
const calls: Record<string, unknown>[] = []
let saved = true
let unavailable = false
let failureCode = 'XX000'
const backend = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async request => {
  const path = new URL(request.url).pathname
  const body = await request.json()
  if (path === '/rest/v1/rpc/get_trade_revaluation_inputs') {
    assert.deepEqual(body, { p_user_id: userId, p_member_id: memberId, p_trade_id: tradeId })
    return unavailable ? Response.json({ message: 'valuation failed', code: failureCode }, { status: 500 }) : Response.json(inputs)
  }
  assert.equal(path, '/rest/v1/rpc/view_refresh_work')
  calls.push(body)
  if (body.p_params.operation === 'claim') return Response.json([{ leagueId, seasonId, version: 12, claimToken,
    trades: [{ tradeId, memberId, userId }] }])
  return Response.json(saved)
})
Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(backend.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_refresh_fixture')
const { refreshViews } = await import('./work.ts')
const { analyzeTradeEstimate } = await import('../_shared/tradeEstimate.ts')

Deno.test('refresh worker publishes the existing trade model with the exact claimed version and token', async () => {
  const output = await refreshViews()
  assert.equal(output.rowsAffected, 1)
  assert.deepEqual(output.result, { completed: 1, failures: [] })
  const complete = calls.at(-1)!
  assert.equal(complete.p_league_id, leagueId)
  const params = complete.p_params as Record<string, unknown>
  assert.equal(params.version, 12)
  assert.equal(params.claimToken, claimToken)
  assert.equal(params.operation, 'complete')
  const values = params.tradeValues as { tradeId: string; revaluation: { analysis: unknown; inputVersion: string } }[]
  assert.equal(values[0].tradeId, tradeId)
  assert.equal(values[0].revaluation.inputVersion, inputs.inputVersion)
  assert.deepEqual(values[0].revaluation.analysis, analyzeTradeEstimate(inputs, Date.parse(inputs.observedAt)))
})

Deno.test('stale publication is not counted as a successful refresh', async () => {
  saved = false
  const output = await refreshViews()
  assert.equal(output.rowsAffected, 0)
  assert.deepEqual(output.result, { completed: 0, failures: [] })
  saved = true
})

Deno.test('failed valuation releases the lease for retry without publishing partial tables', async () => {
  unavailable = true
  const before = calls.length
  const output = await refreshViews()
  assert.equal(output.rowsAffected, 0)
  assert.equal(output.result.failures.length, 1)
  assert.match(output.failure!, /valuation failed/)
  const operations = calls.slice(before).map(call => (call.p_params as Record<string, unknown>).operation)
  assert.deepEqual(operations, ['claim', 'fail'])
  unavailable = false
})

Deno.test('unavailable historical inputs do not prevent refreshing league numbers', async () => {
  unavailable = true
  failureCode = '22023'
  const output = await refreshViews()
  assert.equal(output.rowsAffected, 1)
  assert.deepEqual(output.result.failures, [])
  const params = calls.at(-1)!.p_params as Record<string, unknown>
  assert.deepEqual(params.tradeValues, [{ tradeId, revaluation: { tradeId, unavailableReason: 'valuation failed' } }])
  unavailable = false
  failureCode = 'XX000'
})

Deno.test({ name: 'close refresh view test server', sanitizeOps: false, sanitizeResources: false, fn: () => backend.shutdown() })

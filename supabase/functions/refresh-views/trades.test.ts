import { strict as assert } from 'node:assert'

const tradeId = '20000000-0000-4000-8000-000000000001'
const memberId = '20000000-0000-4000-8000-000000000002'
const userId = '20000000-0000-4000-8000-000000000003'
const leagueId = '20000000-0000-4000-8000-000000000004'
const seasonId = '20000000-0000-4000-8000-000000000005'
const inputs = { leagueId, seasonId, seasonYear: 2027, teams: 2, rosterSize: 20, scoringSettings: { points: 1 }, faabBudget: 100,
  terms: [{ fromMemberId: memberId, toMemberId: userId, playerId: null, pickId: null, faabAmount: 5 }],
  players: [], replacementPlayers: [], picks: [], inputVersion: 'fingerprint', observedAt: '2026-10-29T12:00:00Z' }
const calls: { name: string; body: Record<string, unknown> }[] = []
let current: Record<string, unknown> = inputs
let timeout = false
let saved = true
const backend = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async request => {
  const name = new URL(request.url).pathname.split('/').at(-1)!
  const body = await request.json()
  calls.push({ name, body })
  if (name === 'get_trade_revaluation_inputs') return timeout
    ? Response.json({ message: 'canceling statement due to statement timeout', code: '57014' }, { status: 500 })
    : Response.json(current)
  assert.equal(name, 'view_refresh_work')
  if (body.p_params.operation === 'claim') return Response.json([{ leagueId, seasonId, version: 5, claimToken: tradeId }])
  if (body.p_params.operation === 'queue-trades') return Response.json({ queued: 2 })
  return Response.json(saved)
})
Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(backend.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_refresh_fixture')
const { refreshTradeWork } = await import('./trades.ts')
const { refreshViews } = await import('./work.ts')
const { DYNASTY_TRADE_MODEL_VERSION } = await import('../_shared/dynastyEngine.ts')
const job = { tradeId, memberId, userId, inputFingerprint: 'fingerprint' }

Deno.test('a scan only queues bounded per-trade input checks', async () => {
  calls.length = 0
  assert.equal((await refreshTradeWork({ revaluationScan: true, seasonId, version: 5 })).rowsAffected, 2)
  assert.equal(calls.length, 1)
  assert.equal((calls[0].body.p_params as Record<string, unknown>).operation, 'queue-trades')
})

Deno.test('unchanged input checks do not run valuation publication', async () => {
  calls.length = 0
  saved = false
  assert.equal((await refreshTradeWork({ ...job, checkInputs: true })).rowsAffected, 0)
  assert.deepEqual(calls.map(call => call.name), ['view_refresh_work'])
  assert.equal((calls[0].body.p_params as Record<string, unknown>).operation, 'check-trade')
  saved = true
})

Deno.test('closed trades neither queue nor publish valuations', async () => {
  calls.length = 0
  current = { closed: true, cachedRevaluation: { frozen: true } }
  saved = false
  assert.equal((await refreshTradeWork({ ...job, checkInputs: true })).rowsAffected, 0)
  saved = true
  assert.equal((await refreshTradeWork(job)).rowsAffected, 0)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(call => call.name), ['view_refresh_work', 'get_trade_revaluation_inputs'])
  current = inputs
})

Deno.test('changed inputs publish exactly their fingerprint and retry from the cached value', async () => {
  calls.length = 0
  assert.equal((await refreshTradeWork(job)).rowsAffected, 1)
  const published = (calls.at(-1)!.body.p_params as { revaluation: Record<string, unknown> }).revaluation
  assert.equal(published.inputVersion, 'fingerprint')
  assert.equal(published.modelVersion, DYNASTY_TRADE_MODEL_VERSION)
  current = { ...inputs, cachedRevaluation: published }
  assert.equal((await refreshTradeWork(job)).rowsAffected, 0)
  assert.equal(calls.filter(call => (call.body.p_params as Record<string, unknown>)?.operation === 'publish-trade').length, 1)
  current = inputs
})

Deno.test('a superseded fingerprint and rejected publication perform no successful valuation', async () => {
  calls.length = 0
  assert.equal((await refreshTradeWork({ ...job, inputFingerprint: 'old' })).rowsAffected, 0)
  assert.equal(calls.length, 1)
  saved = false
  assert.equal((await refreshTradeWork(job)).rowsAffected, 0)
  saved = true
})

Deno.test('coalesced work waits for its window and then reads fresh inputs', async () => {
  calls.length = 0
  saved = false
  assert.equal((await refreshTradeWork({ ...job, latestInputs: true })).rowsAffected, 0)
  assert.equal(calls.length, 1)
  assert.equal((calls[0].body.p_params as Record<string, unknown>).operation, 'begin-trade')
  calls.length = 0
  saved = true
  assert.equal((await refreshTradeWork({ ...job, inputFingerprint: 'obsolete', latestInputs: true })).rowsAffected, 1)
  assert.deepEqual(calls.map(call => call.name), ['view_refresh_work', 'get_trade_revaluation_inputs', 'view_refresh_work'])
})

Deno.test('one timed-out trade leaves screens independently runnable', async () => {
  timeout = true
  await assert.rejects(() => refreshTradeWork(job), error => (error as { code: string }).code === '57014')
  assert.equal((await refreshViews()).rowsAffected, 1)
  timeout = false
})

Deno.test({ name: 'close trade test server', sanitizeOps: false, sanitizeResources: false, fn: () => backend.shutdown() })

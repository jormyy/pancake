import assert from 'node:assert/strict'

const trade = '11111111-1111-4111-8111-111111111111'
const member = '22222222-2222-4222-8222-222222222222'
const other = '33333333-3333-4333-8333-333333333333'
let attached = false
let inputCalls = 0
const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async req => {
  const path = new URL(req.url).pathname
  if (path === '/rest/v1/trade_estimates') return Response.json({ quote_id: attached ? trade : null })
  if (path === '/rest/v1/trades') return Response.json({ proposer_member_id: member })
  if (path === '/rest/v1/league_members') return Response.json({ user_id: member })
  if (path.endsWith('/get_trade_revaluation_inputs')) {
    inputCalls++
    return Response.json({ leagueId: trade, seasonId: trade, seasonYear: 2027, teams: 2, rosterSize: 20,
      scoringSettings: { points: 1 }, faabBudget: 100, players: [], replacementPlayers: [], picks: [],
      balances: [{ memberId: member, balance: 100 }, { memberId: other, balance: 100 }],
      terms: [{ fromMemberId: member, toMemberId: other, faabAmount: 1 },
        { fromMemberId: other, toMemberId: member, faabAmount: 1 }],
      revaluationTradeId: trade, inputVersion: 'fixture', observedAt: new Date().toISOString() })
  }
  if (path.endsWith('/save_trade_estimate_quote')) {
    const body = await req.json()
    assert.equal(body.p_inputs.submittedTradeId, trade)
    assert.equal(body.p_inputs.revaluationTradeId, undefined)
    assert.equal(body.p_analysis.teams.length, 2)
    attached = true
    return Response.json({ id: trade })
  }
  throw new Error(`Unexpected request: ${path}`)
})
Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
Deno.env.set('PANCAKE_EDGE_INTERNAL_TOKEN', 'test')
const { handleTradeEstimateWork } = await import('./tradeEstimateWork.ts')

Deno.test('estimate work rejects a public request', async () => {
  const response = await handleTradeEstimateWork(new Request('http://localhost/trades/estimate-work', { method: 'POST' }))
  assert.equal(response.status, 401)
  assert.equal(inputCalls, 0)
})

Deno.test('estimate work runs after submission and safely replays', async () => {
  const request = () => new Request('http://localhost/trades/estimate-work', { method: 'POST',
    headers: { 'x-internal-function-token': 'test', 'content-type': 'application/json' }, body: JSON.stringify({ tradeId: trade }) })
  assert.equal((await handleTradeEstimateWork(request())).status, 200)
  assert.equal((await handleTradeEstimateWork(request())).status, 200)
  assert.equal(inputCalls, 1)
})

Deno.test({ name: 'estimate worker server closes', sanitizeOps: false, sanitizeResources: false, fn: () => server.shutdown() })

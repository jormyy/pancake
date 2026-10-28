import assert from 'node:assert/strict'

const user = '22222222-2222-4222-8222-222222222222'
const member = '33333333-3333-4333-8333-333333333333'
const trade = '44444444-4444-4444-8444-444444444444'
let activationCalls = 0
const drains: string[] = []
const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, req => {
  const path = new URL(req.url).pathname
  if (path === '/auth/v1/user') return Response.json({ id: user, aud: 'authenticated', role: 'authenticated' })
  if (path === '/rest/v1/league_members') return Response.json({ id: member, user_id: user })
  if (path === '/rest/v1/rpc/accept_trade_atomic') return Response.json({ allAccepted: true, expired: false })
  if (path === '/rest/v1/trades') return Response.json({ league_id: member, league_season_id: member })
  if (path === '/rest/v1/drafts') return Response.json({ id: trade })
  if (path === '/rest/v1/rpc/activate_rookie_draft_league_atomic') {
    activationCalls++
    return Response.json({ message: 'Activation unavailable' }, { status: 500 })
  }
  if (path.endsWith('/expire_pending_trades_atomic')) return Response.json(0)
  if (path.endsWith('/process_due_accepted_trades_atomic')) return Response.json([{ trade_id: trade, status: 'completed', error_code: null, error_message: null }])
  if (path.endsWith('/claim_notification_outbox_atomic') || path.endsWith('/claim_notification_receipts_atomic')) {
    drains.push(path.split('/').at(-1)!)
    return Response.json([])
  }
  throw new Error(`Unexpected request: ${path}`)
})
Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
const { handleTradeRoute } = await import('./trades.ts')

Deno.test('accept returns its committed trade without running activation', async () => {
  const path = `/trades/${trade}/accept`
  const response = await handleTradeRoute(new Request(`http://localhost${path}`, {
    method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
    body: JSON.stringify({ memberId: member }),
  }), path)
  assert.equal(response?.status, 200)
  assert.equal(activationCalls, 0)
  assert.deepEqual(await response?.json(), { ok: true, tradeId: trade })
})

Deno.test('trade worker drains notifications and receipts after activation fails', async () => {
  Deno.env.set('PANCAKE_EDGE_INTERNAL_TOKEN', 'trade-worker-test')
  let handler!: (request: Request) => Promise<Response>
  const descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
  Object.defineProperty(Deno, 'serve', { value: (callback: typeof handler) => { handler = callback } })
  try { await import('../process-trades/index.ts') } finally { Object.defineProperty(Deno, 'serve', descriptor) }
  const response = await handler(new Request('http://localhost/process-trades', { method: 'POST',
    headers: { 'x-internal-function-token': 'trade-worker-test' } }))
  assert.equal(response.status, 200)
  assert.deepEqual(drains, ['claim_notification_outbox_atomic', 'claim_notification_receipts_atomic'])
})

Deno.test({ name: 'trade activation server closes', sanitizeOps: false, sanitizeResources: false, fn: () => server.shutdown() })

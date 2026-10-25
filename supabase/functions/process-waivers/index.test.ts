import { strict as assert } from 'node:assert'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'waiver-queue-test')
Deno.env.set('PANCAKE_EDGE_INTERNAL_TOKEN', 'waiver-internal-test')
let handler!: (request: Request) => Promise<Response>
const descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
Object.defineProperty(Deno, 'serve', { value: (callback: typeof handler) => { handler = callback } })
try { await import('./index.ts') } finally { Object.defineProperty(Deno, 'serve', descriptor) }

Deno.test('waiver processing leaves result notifications to the database triggers', async () => {
  const nativeFetch = globalThis.fetch
  const queued: Record<string, unknown>[] = []
  let batches = 0
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname.endsWith('/process_due_waiver_claims_atomic')) return Response.json(batches++ === 0 ? [
      { claim_id: 'won', member_id: 'member', player_id: 'player', status: 'succeeded', processed: true },
      { claim_id: 'lost', member_id: 'member', player_id: 'player', status: 'failed_priority', failure_reason: 'Higher priority', processed: true },
      { claim_id: 'full', member_id: 'member', player_id: 'player', status: 'failed_roster', processed: true },
      { claim_id: 'cancelled', member_id: 'member', player_id: 'player', status: 'cancelled', processed: true },
    ] : [])
    if (url.pathname.endsWith('/players')) return Response.json([{ id: 'player', display_name: 'Player' }])
    if (url.pathname.endsWith('/notification_outbox')) {
      assert.equal(request.method, 'POST')
      assert.equal(url.searchParams.get('on_conflict'), 'dedupe_key')
      assert.ok(request.headers.get('prefer')?.includes('resolution=ignore-duplicates'))
      const body = await request.json()
      queued.push(...(Array.isArray(body) ? body : [body]))
    }
    return Response.json([])
  }
  try {
    const response = await handler(new Request('http://localhost', { headers: { 'x-internal-function-token': 'waiver-internal-test' } }))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, processed: 4 })
    assert.deepEqual(queued, [])
  } finally { globalThis.fetch = nativeFetch }
})

Deno.test('waiver batches and expiry do not depend on an Edge notification write', async () => {
  const nativeFetch = globalThis.fetch
  const nativeError = console.error
  const errors: unknown[][] = []
  let batches = 0
  let queued = 0
  let expired = false
  console.error = (...args) => { errors.push(args) }
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const table = url.pathname.split('/').at(-1)
    if (table === 'process_due_waiver_claims_atomic') {
      batches++
      return Response.json(batches > 2 ? [] : [{ claim_id: `claim-${batches}`, member_id: 'member', player_id: 'player',
        status: 'succeeded', processed: true }])
    }
    if (table === 'players') return Response.json([{ id: 'player', display_name: 'Player' }])
    if (table === 'notification_outbox') {
      queued++
      return queued === 1 ? Response.json({ message: 'Queue unavailable' }, { status: 503 }) : Response.json([])
    }
    if (table === 'expire_waiver_wire_logs') { expired = true; return Response.json(1) }
    return Response.json([])
  }
  try {
    const response = await handler(new Request('http://edge.test/process-waivers', { method: 'POST',
      headers: { 'x-internal-function-token': 'waiver-internal-test' } }))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, processed: 2 })
    assert.equal(batches, 4)
    assert.equal(queued, 0)
    assert.equal(expired, true)
    assert.deepEqual(errors, [])
  } finally { globalThis.fetch = nativeFetch; console.error = nativeError }
})

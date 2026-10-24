import { strict as assert } from 'node:assert'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'waiver-queue-test')
Deno.env.set('PANCAKE_EDGE_INTERNAL_TOKEN', 'waiver-internal-test')
let handler!: (request: Request) => Promise<Response>
const descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
Object.defineProperty(Deno, 'serve', { value: (callback: typeof handler) => { handler = callback } })
try { await import('./index.ts') } finally { Object.defineProperty(Deno, 'serve', descriptor) }

Deno.test('waiver results enter the durable outbox with one key per resolved claim', async () => {
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
    assert.deepEqual(queued.map(row => row.dedupe_key).sort(), ['waiver_result:full', 'waiver_result:lost', 'waiver_result:won'])
    assert.ok(queued.every(row => row.category === 'waiver' && row.member_id === 'member'))
    assert.ok(queued.find(row => row.dedupe_key === 'waiver_result:won')?.body === 'Player has been added to your roster.')
    assert.ok(String(queued.find(row => row.dedupe_key === 'waiver_result:lost')?.body).includes('Higher priority'))
  } finally { globalThis.fetch = nativeFetch }
})

import { strict as assert } from 'node:assert'

const calls: { p_kind: string; p_requeue?: boolean }[] = []
let mode = 'short'
const backend = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async request => {
  assert.equal(new URL(request.url).pathname, '/rest/v1/rpc/run_scheduler_chunk')
  calls.push(await request.json())
  if (mode === 'error') return Response.json({ message: 'fixture chunk failed', code: '57014' }, { status: 500 })
  if (mode === 'invalid') return Response.json({ processed: 2, remaining: false })
  return Response.json({ processed: calls.at(-1)?.p_requeue ? 0 : 1, remaining: mode === 'long' || calls.length < 3 })
})
Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(backend.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_scheduler_fixture')
const { runScheduledChunks } = await import('./scheduled.ts')

Deno.test('a scheduler worker drains chunks until the database reports completion', async () => {
  calls.length = 0
  mode = 'short'
  const result = await runScheduledChunks('notifications')
  assert.equal(result.rowsAffected, 3)
  assert.equal(result.result.continued, false)
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ({ p_kind: 'notifications' })))
})

Deno.test('a large scheduler scan yields after sixty-four chunks and queues its continuation', async () => {
  calls.length = 0
  mode = 'long'
  const result = await runScheduledChunks('forecasts')
  assert.equal(result.rowsAffected, 64)
  assert.equal(result.result.continued, true)
  assert.equal(calls.length, 65)
  assert.deepEqual(calls.at(-1), { p_kind: 'forecasts', p_requeue: true })
})

Deno.test('a failed chunk fails the worker instead of discarding its retry evidence', async () => {
  calls.length = 0
  mode = 'error'
  await assert.rejects(() => runScheduledChunks('notifications'), { message: 'fixture chunk failed' })
  assert.equal(calls.length, 1)
})

Deno.test('an invalid chunk receipt fails the worker', async () => {
  calls.length = 0
  mode = 'invalid'
  await assert.rejects(() => runScheduledChunks('forecasts'), /Invalid scheduler chunk receipt/)
  assert.equal(calls.length, 1)
})

Deno.test('unknown chunk kinds cannot call the database', async () => {
  calls.length = 0
  await assert.rejects(() => runScheduledChunks('other'), /Unknown scheduler chunk/)
  assert.equal(calls.length, 0)
})

globalThis.addEventListener('unload', () => { backend.shutdown() })

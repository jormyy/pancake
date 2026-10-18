import { strict as assert } from 'node:assert'

Deno.test('request-scoped deadlines and lease headers', async t => {
const database = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async req => {
  await new Promise(resolve => setTimeout(resolve, 10))
  return Response.json({ holder: req.headers.get('x-pancake-live-holder') })
})
const external = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, req => {
  if (new URL(req.url).pathname === '/body') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) } }))
  return Response.json({ holder: req.headers.get('x-pancake-live-holder') })
})
Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${database.addr.port}`)
const { withWorkContext, withoutWorkContext, workFetch } = await import('./workContext.ts')

try {
await t.step('concurrent work contexts keep their lease identity and do not send it upstream', async () => {
  const holders = [crypto.randomUUID(), crypto.randomUUID()]
  const results = await Promise.all(holders.map(holder => withWorkContext({ signal: AbortSignal.timeout(5000), livePollHolder: holder }, async () => {
    const db = await (await workFetch(`http://127.0.0.1:${database.addr.port}`)).json()
    const upstream = await (await workFetch(`http://127.0.0.1:${external.addr.port}`, { headers: { 'x-pancake-live-holder': holder } })).json()
    return { db: db.holder, upstream: upstream.holder }
  })))
  assert.deepEqual(results, holders.map(holder => ({ db: holder, upstream: null })))
  assert.equal((await (await workFetch(`http://127.0.0.1:${database.addr.port}`)).json()).holder, null)
})

await t.step('work deadline cancels a real response body after headers arrive', async () => {
  const started = Date.now()
  await assert.rejects(withWorkContext({ signal: AbortSignal.timeout(100), livePollHolder: crypto.randomUUID() }, async () => {
    const response = await workFetch(`http://127.0.0.1:${external.addr.port}/body`)
    assert.equal(response.status, 200)
    await response.json()
  }), /abort|timeout/i)
  assert.ok(Date.now() - started >= 90)
  assert.ok(Date.now() - started < 2000)
})

await t.step('failure bookkeeping can finish after a work deadline without leaking its lease', async () => {
  const controller = new AbortController()
  controller.abort(new Error('work aborted'))
  await withWorkContext({ signal: controller.signal, livePollHolder: crypto.randomUUID() }, async () => {
    await assert.rejects(async () => { await workFetch(`http://127.0.0.1:${database.addr.port}`) }, /aborted/)
    const result = await withoutWorkContext(async () => await (await workFetch(`http://127.0.0.1:${database.addr.port}`)).json())
    assert.equal(result.holder, null)
    await assert.rejects(async () => { await workFetch(`http://127.0.0.1:${database.addr.port}`) }, /aborted/)
  })
})

} finally {
  await database.shutdown()
  await external.shutdown()
}
})

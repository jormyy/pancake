import { strict as assert } from 'node:assert'

Deno.test('request-scoped deadlines and lease headers', async t => {
const database = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async req => {
  await new Promise(resolve => setTimeout(resolve, 10))
  return Response.json({ holder: req.headers.get('x-pancake-live-holder'), requestId: req.headers.get('x-request-id'), actor: req.headers.get('x-request-actor'), checkpoint: req.headers.get('x-pancake-public-checkpoint') })
})
const external = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, req => {
  if (new URL(req.url).pathname === '/body') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) } }))
  return Response.json({ holder: req.headers.get('x-pancake-live-holder'), requestId: req.headers.get('x-request-id'), actor: req.headers.get('x-request-actor'), checkpoint: req.headers.get('x-pancake-public-checkpoint') })
})
Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${database.addr.port}`)
const { withWorkContext, withoutWorkContext, workFetch, withPublicCheckpoint } = await import('./workContext.ts')

try {
await t.step('concurrent mutations keep their verified actors and do not send identity upstream', async () => {
  const { setRequestActor } = await import('./workContext.ts')
  const actions = [1, 2].map(() => ({ requestId: crypto.randomUUID(), actor: crypto.randomUUID() }))
  const results = await Promise.all(actions.map(action => withWorkContext({ signal: AbortSignal.timeout(5000), requestId: action.requestId }, async () => {
    setRequestActor(action.actor)
    const db = await (await workFetch(`http://127.0.0.1:${database.addr.port}/rest/v1/rpc/reorder_waiver_claim_atomic`)).json()
    const upstream = await (await workFetch(`http://127.0.0.1:${external.addr.port}`, { headers: { 'x-request-id': action.requestId, 'x-request-actor': action.actor } })).json()
    return { requestId: db.requestId, actor: db.actor, upstream }
  })))
  assert.deepEqual(results, actions.map(action => ({ ...action, upstream: { holder: null, requestId: null, actor: null, checkpoint: null } })))
})

await t.step('concurrent work contexts keep their lease identity and do not send it upstream', async () => {
  const holders = [crypto.randomUUID(), crypto.randomUUID()]
  const results = await Promise.all(holders.map(holder => withWorkContext({ signal: AbortSignal.timeout(5000), livePollHolder: holder }, async () => {
    const db = await (await workFetch(`http://127.0.0.1:${database.addr.port}`)).json()
    const upstream = await (await workFetch(`http://127.0.0.1:${external.addr.port}`, { headers: { 'x-pancake-live-holder': holder } })).json()
    return { db: db.holder, upstream: upstream.holder }
  })))
  assert.deepEqual(results, holders.map(holder => ({ db: holder, upstream: null })))
  assert.equal((await (await workFetch(`http://127.0.0.1:${database.addr.port}`)).json()).holder, null)
  const bounded = await withWorkContext({ signal: AbortSignal.timeout(5000) }, async () => await (await workFetch(`http://127.0.0.1:${database.addr.port}`)).json())
  assert.equal(bounded.holder, null)
})

await t.step('only leased public checkpoints carry the database-only marker', async () => {
  await withWorkContext({ signal: AbortSignal.timeout(5000), livePollHolder: crypto.randomUUID() }, async () => {
    await withPublicCheckpoint(true, async () => {
      const db = await (await workFetch(`http://127.0.0.1:${database.addr.port}`)).json()
      assert.equal(db.checkpoint, 'true')
      const upstream = await (await workFetch(`http://127.0.0.1:${external.addr.port}`, { headers: { 'x-pancake-public-checkpoint': 'true' } })).json()
      assert.equal(upstream.checkpoint, null)
    })
    const restored = await (await workFetch(`http://127.0.0.1:${database.addr.port}`)).json()
    assert.equal(restored.checkpoint, null)
  })
  await withWorkContext({ signal: AbortSignal.timeout(5000) }, () => withPublicCheckpoint(true, async () => {
    const db = await (await workFetch(`http://127.0.0.1:${database.addr.port}`)).json()
    assert.equal(db.checkpoint, null)
  }))
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

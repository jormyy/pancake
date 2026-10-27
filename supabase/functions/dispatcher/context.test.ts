import { strict as assert } from 'node:assert'

Deno.test('nested workers inherit the queue fence and cannot send it to a provider', async () => {
  const database = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, request => Response.json({ key: request.headers.get('x-pancake-work-key'), requestId: request.headers.get('x-request-id'), actor: request.headers.get('x-request-actor') }))
  const provider = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, request => Response.json({ key: request.headers.get('x-pancake-work-key'), requestId: request.headers.get('x-request-id'), actor: request.headers.get('x-request-actor') }))
  const previousUrl = Deno.env.get('SUPABASE_URL')
  Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${database.addr.port}`)
  const { withWorkContext, workFetch } = await import('../_shared/workContext.ts')
  try {
    const controller = new AbortController()
    const key = crypto.randomUUID()
    const requestId = crypto.randomUUID()
    const requestActor = crypto.randomUUID()
    await withWorkContext({ signal: controller.signal, workInvocation: key, requestId, requestActor }, async () => {
      await withWorkContext({ signal: new AbortController().signal, livePollHolder: crypto.randomUUID() }, async () => {
        const result = await (await workFetch(`http://127.0.0.1:${database.addr.port}/rest/v1/rpc/auto_set_lineup_atomic`)).json()
        assert.deepEqual(result, { key, requestId, actor: requestActor })
        const table = await (await workFetch(`http://127.0.0.1:${database.addr.port}/rest/v1/weekly_lineups`)).json()
        assert.deepEqual(table, { key, requestId: null, actor: null })
        const external = await (await workFetch(`http://127.0.0.1:${provider.addr.port}`, { headers: { 'x-pancake-work-key': key, 'x-request-id': requestId, 'x-request-actor': requestActor } })).json()
        assert.deepEqual(external, { key: null, requestId: null, actor: null })
        controller.abort(new Error('Queue lease lost'))
        await assert.rejects(async () => await workFetch(`http://127.0.0.1:${database.addr.port}`), /Queue lease lost/)
      })
    })
  } finally {
    if (previousUrl == null) Deno.env.delete('SUPABASE_URL')
    else Deno.env.set('SUPABASE_URL', previousUrl)
    await database.shutdown()
    await provider.shutdown()
  }
})

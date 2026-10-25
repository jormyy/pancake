import { strict as assert } from 'node:assert'

const user = '10000000-0000-4000-8000-000000000001'
const member = '10000000-0000-4000-8000-000000000002'
const claim = '10000000-0000-4000-8000-000000000003'
const calls: Record<string, unknown>[] = []
const backend = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async request => {
  const path = new URL(request.url).pathname
  if (path === '/auth/v1/user') return Response.json({ id: user })
  assert.equal(path, '/rest/v1/rpc/edit_waiver_claim_atomic')
  calls.push(await request.json())
  return new Response(null, { status: 204 })
})
Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(backend.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
const { handleWaiverRoute } = await import('./waivers.ts')

Deno.test('waiver edits omit an unchanged IR choice and preserve explicit false and true', async () => {
  for (const value of [undefined, false, true]) {
    const path = `/waivers/claims/${claim}/edit`
    const response = await handleWaiverRoute(new Request(`http://localhost${path}`, {
      method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
      body: JSON.stringify({ memberId: member, toIr: value }),
    }), path)
    assert.equal(response?.status, 200)
    assert.deepEqual(calls.at(-1), {
      p_claim_id: claim, p_member_id: member, p_user_id: user, p_bid_amount: 0,
      ...(value === undefined ? {} : { p_to_ir: value }),
    })
  }
})

Deno.test({ name: 'close waiver test server', sanitizeOps: false, sanitizeResources: false, fn: () => backend.shutdown() })

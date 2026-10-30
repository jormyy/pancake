Deno.test('beacons route validates bodies and checks membership before insert', async (t) => {
  const userId = '22222222-2222-4222-8222-222222222222'
  const memberId = '33333333-3333-4333-8333-333333333333'
  let inserts = 0
  let inserted: unknown
  const mock = Deno.serve({ hostname: '127.0.0.1', port: 59591, onListen() {} }, async (req) => {
    const url = new URL(req.url)
    if (url.pathname === '/auth/v1/user') {
      return Response.json({ id: userId, aud: 'authenticated', role: 'authenticated' })
    }
    if (url.pathname === '/rest/v1/league_members') {
      const owns = url.searchParams.get('id') === `eq.${memberId}` && url.searchParams.get('user_id') === `eq.${userId}`
      return Response.json(owns ? { league_id: '44444444-4444-4444-8444-444444444444' } : null)
    }
    if (url.pathname === '/rest/v1/perf_beacons' && req.method === 'POST') {
      inserts += 1
      inserted = await req.json()
      return new Response(null, { status: 201 })
    }
    throw Error(`Unexpected request: ${req.method} ${url.pathname}`)
  })
  Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:59591')
  Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_synthetic_beacon_test')
  try {
    const { handleApiRoute } = await import('../router.ts')
    const row = { screen: 'roster', useful_ms: 250, request_count: 3, transfer_bytes: 1024, bytes_complete: true,
      cold: true, device_class: 'phone', connection_type: '4g', app_version: '1.0.0', sample_n: 10 }
    const body = { member_id: memberId, beacons: [row] }
    const request = (payload: unknown, auth = true) => handleApiRoute(new Request('http://127.0.0.1:59521/functions/v1/api/beacons', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': crypto.randomUUID(), ...(auth ? { authorization: 'Bearer synthetic' } : {}) }, body: JSON.stringify(payload),
    }))
    const check = async (payload: unknown, expected: number, auth = true) => {
      const before = inserts
      const response = await request(payload, auth)
      if (response.status !== expected) throw Error(`Expected ${expected}, got ${response.status}: ${await response.text()}`)
      await response.body?.cancel()
      if (expected !== 202 && inserts !== before) throw Error('Rejected body reaches insert')
    }
    await t.step('member batch inserts trusted member id', async () => {
      await check(body, 202)
      const rows = inserted as Record<string, unknown>[]
      if (rows.length !== 1 || rows[0].member_id !== memberId || rows[0].useful_ms !== 250) throw Error('Inserted values differ')
    })
    await t.step('home, waivers and draft setup screens are accepted', async () => {
      for (const screen of ['home', 'waivers', 'draft-setup']) await check({ ...body, beacons: [{ ...row, screen }] }, 202)
    })
    await t.step('API responses allow resource timing sizes', async () => {
      const response = await request(body)
      await response.body?.cancel()
      if (response.headers.get('timing-allow-origin') !== '*') throw Error('Timing-Allow-Origin missing')
    })
    await t.step('missing or malformed request ids reject before insert', async () => {
      const before = inserts
      for (const requestId of [null, 'invalid']) {
        const response = await handleApiRoute(new Request('http://127.0.0.1:59521/functions/v1/api/beacons', {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic',
            ...(requestId ? { 'x-request-id': requestId } : {}) }, body: JSON.stringify(body),
        }))
        if (response.status !== 400) throw Error('Invalid request id accepted')
        await response.body?.cancel()
      }
      if (inserts !== before) throw Error('Invalid request id reaches insert')
    })
    await t.step('anonymous request is rejected', () => check(body, 401, false))
    await t.step('another member is rejected', () => check({ ...body, member_id: '55555555-5555-4555-8555-555555555555' }, 404))
    await t.step('member id must be a UUID', () => check({ ...body, member_id: 'private-data' }, 400))
    await t.step('batch must contain one to twenty rows', async () => {
      for (const beacons of [[], Array(21).fill(row), null, {}]) await check({ ...body, beacons }, 400)
    })
    await t.step('rejects unknown fields and personal data', async () => {
      await check({ ...body, email: 'private@example.test' }, 400)
      await check({ ...body, beacons: [{ ...row, url: '/player/private-id' }] }, 400)
    })
    await t.step('rejects malformed rows and each missing field', async () => {
      for (const value of [null, 1, 'row', [], {}]) await check({ ...body, beacons: [value] }, 400)
      for (const key of Object.keys(row)) {
        const incomplete: Record<string, unknown> = { ...row }
        delete incomplete[key]
        await check({ ...body, beacons: [incomplete] }, 400)
      }
    })
    await t.step('rejects invalid values and numeric bounds', async () => {
      const patches = [{ screen: '/player/private-id' }, { useful_ms: -1 }, { useful_ms: 120001 }, { useful_ms: 1.5 }, { request_count: 10001 },
        { request_count: '1' }, { transfer_bytes: -1 }, { transfer_bytes: 1000000001 }, { bytes_complete: null }, { cold: 1 },
        { device_class: 'exact-device' }, { connection_type: 'wifi-name' }, { app_version: 'email@example.test' }, { sample_n: 0 }, { sample_n: 10001 }]
      for (const patch of patches) await check({ ...body, beacons: [{ ...row, ...patch }] }, 400)
    })
    await t.step('rejects bodies over eight KB without content length', () => check({ ...body, padding: 'x'.repeat(8192) }, 400))
    await t.step('rejects malformed JSON and non-JSON bodies', async () => {
      for (const [text, contentType] of [['{', 'application/json'], [JSON.stringify(body), 'text/plain']]) {
        const response = await handleApiRoute(new Request('http://127.0.0.1:59521/functions/v1/api/beacons', {
          method: 'POST', headers: { authorization: 'Bearer synthetic', 'content-type': contentType, 'x-request-id': crypto.randomUUID() }, body: text,
        }))
        if (response.status !== 400) throw Error('Invalid encoding accepted')
        await response.body?.cancel()
      }
    })
    await t.step('rejects unsupported methods', async () => {
      const response = await handleApiRoute(new Request('http://127.0.0.1:59521/functions/v1/api/beacons'))
      if (response.status !== 405) throw Error('GET accepted')
      await response.body?.cancel()
    })
  } finally { await mock.shutdown() }
})

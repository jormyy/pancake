import assert from 'node:assert/strict'

Deno.env.set('ESPN_LIVE_BASE_URL', 'http://espn.invalid')
const { EspnLiveSource } = await import('./espn.ts')
const raw = JSON.parse(await Deno.readTextFile('tests/fixtures/live-espn/2026-10-30T01-00-49.445Z-scoreboard.json')).payload
const event = raw.events[0]
const summary = JSON.parse(await Deno.readTextFile('tests/fixtures/live-espn/2026-10-30T01-00-49.554Z-summary-401909893.json')).payload

Deno.test('ESPN scoreboard errors back off for 20, 40 and 80 seconds then reset after success', async () => {
  let now = 0, calls = 0, healthy = false
  const source = new EspnLiveSource(() => now)
  const original = globalThis.fetch
  globalThis.fetch = async () => { calls++; return healthy ? Response.json(raw) : Response.json({}, { status: 503 }) }
  try {
    await assert.rejects(() => source.scoreboard(['2026-10-29']), /503/)
    for (const [retryAt, count] of [[20_000, 2], [60_000, 3], [140_000, 4]]) {
      now = retryAt - 1
      await assert.rejects(() => source.scoreboard(['2026-10-29']), /backoff/)
      assert.equal(calls, count - 1)
      now = retryAt
      await assert.rejects(() => source.scoreboard(['2026-10-29']), /503/)
      assert.equal(calls, count)
    }
    healthy = true
    now = 260_000
    assert.equal((await source.scoreboard(['2026-10-29'])).length, raw.events.length)
    assert.equal((await source.scoreboard(['2026-10-29'])).length, raw.events.length)
    assert.equal(calls, 6)
  } finally { globalThis.fetch = original }
})

Deno.test('an inconsistent summary backs off only its own game', async () => {
  let now = Date.parse('2026-10-30T01:00:50Z'), calls = 0
  const source = new EspnLiveSource(() => now)
  const original = globalThis.fetch
  globalThis.fetch = async input => {
    calls++
    const url = new URL(input instanceof Request ? input.url : input)
    return Response.json(url.pathname === '/summary' ? {} : raw)
  }
  try {
    await assert.rejects(() => source.summary(event))
    await assert.rejects(() => source.summary(event), /backoff/)
    assert.equal(calls, 1)
    await source.scoreboard(['2026-10-29'])
    assert.equal(calls, 2)
    now += 20_000
    await assert.rejects(() => source.summary(event))
    now += 20_000
    await assert.rejects(() => source.summary(event), error => !String(error).includes('backoff'))
    assert.equal(calls, 4)
  } finally { globalThis.fetch = original }
})

Deno.test('one bounded attempt times out and enters backoff', async () => {
  const source = new EspnLiveSource(() => Date.parse('2026-10-30T01:00:50Z'), 25)
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
    calls++
    const signal = (init as { signal?: AbortSignal } | undefined)?.signal
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  try {
    await assert.rejects(() => source.summary(event), /timeout|timed out/i)
    await assert.rejects(() => source.summary(event), /backoff/)
    assert.equal(calls, 1)
  } finally { globalThis.fetch = original }
})

Deno.test('future timestamps and duplicate scoreboard identities are rejected', async () => {
  const original = globalThis.fetch
  const source = new EspnLiveSource(() => Date.parse('2026-10-30T00:00:00Z'))
  globalThis.fetch = async input => Response.json(new URL(String(input)).pathname === '/summary' ? summary : { events: [...raw.events, ...raw.events] })
  try {
    await assert.rejects(() => source.summary(event), /future/)
    await assert.rejects(() => source.scoreboard(['2026-10-29']), /duplicate/)
  } finally { globalThis.fetch = original }
})

Deno.test('the request budget also bounds a response body that stalls after headers', async () => {
  const original = globalThis.fetch
  let close: (() => void) | undefined
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"events":'))
      close = () => { try { controller.close() } catch {} }
    },
  }), { headers: { 'content-type': 'application/json' } }))
  const address = server.addr as Deno.NetAddr
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    assert.equal(url.hostname, 'espn.invalid')
    return original(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init)
  }
  try {
    const source = new EspnLiveSource(() => Date.parse('2026-10-30T01:00:50Z'), 30)
    await assert.rejects(() => source.scoreboard(['2026-10-29']))
    await assert.rejects(() => source.scoreboard(['2026-10-29']), /backoff/)
  } finally {
    close?.()
    globalThis.fetch = original
    await server.shutdown()
  }
})

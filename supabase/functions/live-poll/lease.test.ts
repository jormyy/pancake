import assert from 'node:assert/strict'

Deno.env.set('SUPABASE_URL', 'http://database.invalid')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'fixture-key')
const { runEdgeInvocation } = await import('../_shared/syncRuns.ts')
const { renewCurrentWorkLease } = await import('../_shared/workContext.ts')
const { runLivePoll } = await import('./runner.ts')

async function fixture(run: (calls: string[], intervals: Map<number, number>, advance: () => void) => Promise<void>, lose = false) {
  const originalFetch = globalThis.fetch, originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval
  const originalNow = Date.now
  const calls: string[] = [], intervals = new Map<number, number>()
  let clock = 0, next = 0
  Date.now = () => clock
  globalThis.setInterval = ((_callback: unknown, milliseconds: number) => {
    intervals.set(++next, milliseconds)
    return next
  }) as typeof setInterval
  globalThis.clearInterval = ((id: number) => { intervals.delete(id) }) as typeof clearInterval
  globalThis.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : input)
    assert.equal(url.hostname, 'database.invalid')
    const name = url.pathname.split('/').at(-1)!
    calls.push(name)
    if (name === 'try_live_poll_lease') return Response.json('00000000-0000-4000-8000-000000000001')
    if (name === 'get_live_poll_work') return Response.json([])
    if (name === 'sync_runs') return Response.json({ id: 'fixture-run' })
    return Response.json(name === 'renew_work_lease' ? !lose : true)
  }
  try { await run(calls, intervals, () => { clock += 120_000 }) } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
    globalThis.setInterval = originalInterval
    globalThis.clearInterval = originalClear
  }
}

const request = () => new Request('http://function.invalid', { headers: { 'x-pancake-invocation-id': 'fixture', 'x-pancake-work-id': '1' } })

Deno.test('live work reuses the startup lease and renews only after two minutes', async () => {
  await fixture(async (calls, intervals, advance) => {
    await runEdgeInvocation('live-poll', request(), async () => {
      assert.deepEqual([...intervals.values()], [120_000])
      await renewCurrentWorkLease()
      await renewCurrentWorkLease()
      assert.deepEqual(calls, ['start_work_invocation'])
      advance()
      await renewCurrentWorkLease()
      await renewCurrentWorkLease()
      assert.deepEqual(calls, ['start_work_invocation', 'renew_work_lease'])
      return Response.json({ ok: true })
    })
    assert.deepEqual(calls, ['start_work_invocation', 'renew_work_lease', 'finish_edge_invocation'])
    assert.equal(intervals.size, 0)
  })
})

Deno.test('a lost live work lease still aborts the invocation and records failure', async () => {
  await fixture(async (calls, intervals, advance) => {
    await assert.rejects(() => runEdgeInvocation('live-poll', request(), async () => {
      advance()
      await renewCurrentWorkLease()
      return Response.json({ ok: true })
    }), /Work lease lost/)
    assert.deepEqual(calls, ['start_work_invocation', 'renew_work_lease', 'finish_edge_invocation'])
    assert.equal(intervals.size, 0)
  }, true)
})

Deno.test('the live poll lease renews every sixty seconds and releases on idle', async () => {
  await fixture(async (calls, intervals) => {
    const original = globalThis.setInterval
    let interval: number | undefined
    globalThis.setInterval = ((callback: unknown, milliseconds: number) => {
      interval = milliseconds
      return original(callback as () => void, milliseconds)
    }) as typeof setInterval
    await runLivePoll(new Request('http://function.invalid'))
    assert.equal(interval, 60_000)
    assert.equal(calls.filter(name => name === 'release_live_poll_lease').length, 1)
    assert.equal(intervals.size, 0)
  })
})

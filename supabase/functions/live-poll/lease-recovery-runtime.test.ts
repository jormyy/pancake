import assert from 'node:assert/strict'

Deno.env.set('SUPABASE_URL', 'http://database.invalid')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'fixture-key')
const { runLivePoll } = await import('./runner.ts')

Deno.test('a temporary gateway failure on the running heartbeat does not lose a valid lease', async () => {
  const originalFetch = globalThis.fetch
  const originalInterval = globalThis.setInterval
  const originalClear = globalThis.clearInterval
  let heartbeat: (() => void) | undefined
  let releaseWork: (() => void) | undefined
  let renewals = 0
  let releases = 0
  globalThis.setInterval = ((callback: () => void, milliseconds: number) => {
    assert.equal(milliseconds, 60000)
    heartbeat = callback
    return 1
  }) as typeof setInterval
  globalThis.clearInterval = (() => {}) as typeof clearInterval
  globalThis.fetch = async input => {
    const name = new URL(input instanceof Request ? input.url : input).pathname.split('/').at(-1)
    if (name === 'try_live_poll_lease') return Response.json('00000000-0000-4000-8000-000000000001')
    if (name === 'get_live_poll_work') {
      await new Promise<void>(resolve => { releaseWork = resolve })
      return Response.json([])
    }
    if (name === 'renew_live_poll_lease') {
      renewals++
      return renewals === 1
        ? Response.json({ message: 'An invalid response was received from the upstream server' }, { status: 502 })
        : Response.json(true)
    }
    if (name === 'release_live_poll_lease') releases++
    return Response.json(name === 'sync_runs' ? { id: 'fixture-run' } : true)
  }
  let run: Promise<Response> | undefined
  try {
    run = runLivePoll(new Request('http://function.invalid'))
    for (let turn = 0; !releaseWork && turn < 100; turn++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(heartbeat && releaseWork)
    heartbeat()
    await new Promise(resolve => setTimeout(resolve, 250))
    releaseWork()
    const response = await run
    assert.equal(response.status, 200)
    assert.equal((await response.json()).ok, true)
    assert.equal(renewals, 2)
    assert.equal(releases, 1)
  } finally {
    releaseWork?.()
    await run?.catch(() => {})
    globalThis.fetch = originalFetch
    globalThis.setInterval = originalInterval
    globalThis.clearInterval = originalClear
  }
})

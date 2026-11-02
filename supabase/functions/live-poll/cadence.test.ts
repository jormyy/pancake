import assert from 'node:assert/strict'

Deno.env.set('SUPABASE_URL', 'http://database.invalid')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'fixture-key')
Deno.env.set('ESPN_LIVE_BASE_URL', 'http://espn.invalid')
const { runLivePoll } = await import(Deno.env.get('PANCAKE_CADENCE_SOURCE') ?? './runner.ts')

async function measureCadence(live: boolean) {
  const original = { now: Date.now, fetch, setTimeout, clearTimeout, setInterval, clearInterval }
  let now = 0
  const ticks: number[] = []
  Date.now = () => now
  globalThis.setTimeout = ((callback: () => void, milliseconds: number) => {
    if (milliseconds <= 30_000) queueMicrotask(() => { now += milliseconds; callback() })
    return 1
  }) as typeof setTimeout
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout
  globalThis.setInterval = (() => 1) as typeof setInterval
  globalThis.clearInterval = (() => {}) as typeof clearInterval
  globalThis.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.hostname === 'espn.invalid') return Response.json({ events: [] })
    assert.equal(url.hostname, 'database.invalid')
    const name = url.pathname.split('/').at(-1)
    if (name === 'try_live_poll_lease') return Response.json('00000000-0000-4000-8000-000000000001')
    if (name === 'get_live_poll_work') {
      ticks.push(now)
      return Response.json(live ? [{ id: '00000000-0000-4000-8000-000000000002', nba_game_id: '0022600001',
        game_date: '2026-11-01', status: 'InProgress', needs_scoreboard: false, needs_stats: false }] : [])
    }
    return Response.json(name === 'sync_runs' ? { id: 'fixture' } : true)
  }
  try {
    const response = await runLivePoll(new Request('http://worker.invalid'))
    assert.equal(response.status, 200)
    return ticks
  } finally {
    Date.now = original.now
    globalThis.fetch = original.fetch
    globalThis.setTimeout = original.setTimeout
    globalThis.clearTimeout = original.clearTimeout
    globalThis.setInterval = original.setInterval
    globalThis.clearInterval = original.clearInterval
  }
}

Deno.test('live games use a thirty-second tick throughout the worker lifetime', async () => {
  assert.deepEqual(await measureCadence(true), [0,30_000,60_000,90_000])
})

Deno.test('an idle slate stops without another live tick', async () => {
  assert.deepEqual(await measureCadence(false), [0])
})

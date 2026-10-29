import { strict as assert } from 'node:assert'
import { withWorkContext } from '../_shared/workContext.ts'

for (const [key, value] of Object.entries({
  SUPABASE_URL: 'http://database.invalid',
  PLAYER_SYNC_SOURCE: 'espn',
  PANCAKE_SUPABASE_SECRET_KEY: 'fixture-key',
  PANCAKE_EDGE_INTERNAL_TOKEN: 'fixture-token',
  ESPN_SITE_BASE_URL: 'http://espn.invalid',
})) Deno.env.set(key, value)

type Handler = (request: Request) => Promise<Response>
let handler: Handler
const descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
Object.defineProperty(Deno, 'serve', { value: (callback: Handler) => { handler = callback } })
try {
  await import('./index.ts')
} finally {
  Object.defineProperty(Deno, 'serve', descriptor)
}

const injury = (displayName: string, status = 'Out') => ({ status, athlete: { displayName } })
const player = (id: string, display_name: string, injury_status: string | null = null) => ({ id, display_name, injury_status, espn_id: id, nba_team: 'BOS', injury_reason: 'unknown', injury_expected_return: 'unknown' })

async function refresh(payload: unknown, players: { id: string; display_name: string; injury_status: string | null; espn_id: string | null; nba_team: string | null }[] = [player('scratch', 'Afternoon Scratch')], body: unknown = {}, token: string | null = 'fixture-token', patchErrors: { code: string; message: string }[] = [], afterLink?: () => void) {
  const originalFetch = globalThis.fetch
  const originalError = console.error
  const logs: string[] = []
  console.error = (...values) => { logs.push(JSON.stringify(values)) }
  const requests: string[] = []
  const writes: { id: string | null; body: Record<string, unknown> }[] = []
  const runs: Record<string, unknown>[] = []
  const writeFilters: string[] = []
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    requests.push(url.pathname)
    if (url.hostname === 'espn.invalid') {
      if (url.pathname === '/injuries') return payload instanceof Response ? payload.clone() : Response.json(payload)
      if (url.pathname === '/teams') return Response.json({})
    }
    assert.equal(url.hostname, 'database.invalid', url.href)
    if (url.pathname === '/rest/v1/sync_runs') {
      runs.push(await request.json())
      if (request.method === 'POST') return Response.json({ id: 'run' })
      return Response.json({})
    }
    if (url.pathname === '/rest/v1/rpc/link_player_sources_atomic') {
      const body = await request.json()
      assert.equal(body.p_source, 'espn')
      assert.equal(body.p_records.length, 1)
      const result = body.p_records.map((row: { provider_id: string; display_name: string }, index: number) => {
        const matched = players.find(player => player.display_name === row.display_name)!
        assert.ok(matched)
        matched.espn_id = row.provider_id
        return { index, player_id: matched.id, action: 'updated' }
      })
      afterLink?.()
      return Response.json({ results: result })
    }
    assert.equal(url.pathname, '/rest/v1/players')
    if (request.method === 'PATCH') {
      writes.push({ id: url.searchParams.get('id'), body: await request.json() })
      writeFilters.push(url.search)
      const error = patchErrors.shift()
      if (error) return Response.json(error, { status: 500 })
      return Response.json([{ id: url.searchParams.get('id')?.slice(3) }])
    }
    return Response.json(players)
  }
  try {
    const response = await handler!(new Request('http://function.invalid', {
      method: 'POST', headers: { ...(token ? { 'x-internal-function-token': token } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))
    return { response, result: await response.json(), requests, writes, runs, logs, writeFilters }
  } finally {
    globalThis.fetch = originalFetch
    console.error = originalError
  }
}

Deno.test('an afternoon scratch updates the stored injury before the next lineup dispatch', async () => {
  const result = await refresh({ injuries: [{ injuries: [injury('Afternoon Scratch')] }] })
  assert.equal(result.response.status, 200)
  assert.deepEqual(result.writes, [{ id: 'eq.scratch', body: { injury_status: 'Out', injury_reason: 'unknown', injury_expected_return: 'unknown' } }])
  assert.equal(result.result.updated, 1)
  assert.equal(result.runs[0].function_name, 'sync-player-injuries')
  assert.equal(result.runs.at(-1)?.rows_affected, 1)
  assert.deepEqual(result.requests.filter(path => !path.startsWith('/rest/')), ['/injuries'])
})

Deno.test('players without an ESPN id keep their injury', async () => {
  const scratch = { ...player('unlinked', 'Afternoon Scratch'), espn_id: null }
  const result = await refresh({ injuries: [{ injuries: [injury('Afternoon Scratch')] }] }, [scratch])
  assert.equal(result.response.status, 200)
  assert.deepEqual(result.writes, [])
})

Deno.test('an injury player-card link connects the missing ESPN identity before applying the injury', async () => {
  const scratch = { ...player('unlinked', 'Afternoon Scratch'), espn_id: null }
  const result = await refresh({ injuries: [{ id: '2', displayName: 'Boston Celtics', injuries: [{
    status: 'Out', athlete: { displayName: 'Afternoon Scratch', links: [{ href: 'https://www.espn.com/nba/player/_/id/12345/afternoon-scratch' }],
      position: { abbreviation: 'G' }, experience: { years: 2 } },
  }] }] }, [scratch])
  assert.equal(result.response.status, 200)
  assert.equal(scratch.espn_id, '12345')
  assert.deepEqual(result.writes, [{ id: 'eq.unlinked', body: { injury_status: 'Out', injury_reason: 'unknown', injury_expected_return: 'unknown' } }])
  assert.ok(result.requests.indexOf('/rest/v1/rpc/link_player_sources_atomic') < result.requests.indexOf('/rest/v1/players'))
})

Deno.test('unchanged injuries fetch once and write no player rows', async () => {
  const result = await refresh({ injuries: [{ injuries: [injury('Afternoon Scratch')] }] }, [player('scratch', 'Afternoon Scratch', 'Out')])
  assert.equal(result.response.status, 200)
  assert.deepEqual(result.writes, [])
  assert.equal(result.result.updated, 0)
})

Deno.test('a healthy feed clears a recovered player and joins names with the full-sync key', async () => {
  const result = await refresh({ injuries: [{ injuries: [injury('Nicolas Claxton')] }] }, [
    player('scratch', 'Nicolás Claxton Jr.'), player('recovered', 'Recovered Player', 'Out'),
    player('healthy', 'Healthy Player'),
  ])
  assert.equal(result.response.status, 200)
  assert.deepEqual(result.writes, [
    { id: 'eq.recovered', body: { injury_status: null, injury_reason: 'unknown', injury_expected_return: 'unknown' } }, { id: 'eq.scratch', body: { injury_status: 'Out', injury_reason: 'unknown', injury_expected_return: 'unknown' } },
  ])
})

Deno.test('a shared name never changes either player injury', async () => {
  const result = await refresh({ injuries: [{ injuries: [injury('Same Name')] }] }, [
    player('one', 'Same Name', 'Out'), player('two', 'Same Name Jr.'),
  ])
  assert.equal(result.response.status, 200)
  assert.deepEqual(result.writes, [])
})

Deno.test('each injury identity links in a separate transaction before guarded status writes', async () => {
  const rows = [player('one', 'First Scratch'), player('two', 'Second Scratch')]
  const result = await refresh({ injuries: [{ id: '2', injuries: rows.map((row, index) => ({
    status: 'Out', athlete: { displayName: row.display_name, id: String(12345 + index) },
  })) }] }, rows)
  assert.equal(result.response.status, 200)
  assert.equal(result.result.updated, 2)
  assert.equal(result.requests.filter(path => path.endsWith('/link_player_sources_atomic')).length, 2)
  assert.equal(result.writes.length, 2)
})

Deno.test('a short identity pass renews before linking and before guarded injury writes', async () => {
  const rows = Array.from({ length: 20 }, (_, index) => player(`fixture-${index}`, `Scratch ${String.fromCharCode(65 + index)}`, 'Out'))
  let renewals = 0
  const result = await withWorkContext({ signal: new AbortController().signal, renewLease: async () => { renewals++ } },
    () => refresh({ injuries: [{ id: '2', injuries: rows.map((row, index) => ({
      status: 'Out', athlete: { displayName: row.display_name, id: String(12345 + index) },
    })) }] }, rows))
  assert.equal(result.response.status, 200)
  assert.equal(renewals, 2)
  assert.equal(result.requests.filter(path => path.endsWith('/link_player_sources_atomic')).length, 20)
  assert.equal(result.writes.length, 0)
})

Deno.test('a long identity pass renews before another two minutes of work', async () => {
  const nativeNow = Date.now
  let at = nativeNow()
  Date.now = () => at
  const rows = ['First', 'Second', 'Third'].map(name => player(name, `${name} Scratch`, 'Out'))
  const renewals: number[] = []
  try {
    const result = await withWorkContext({ signal: new AbortController().signal, renewLease: async () => { renewals.push(at) } },
      () => refresh({ injuries: [{ id: '2', injuries: rows.map((row, index) => ({
        status: 'Out', athlete: { displayName: row.display_name, id: String(12345 + index) },
      })) }] }, rows, {}, 'fixture-token', [], () => { at += 120_001 }))
    assert.equal(result.response.status, 200)
    assert.equal(renewals.length, 4)
    assert.ok(renewals.every((value, index) => index === 0 || value - renewals[index - 1] === 120_001))
  } finally { Date.now = nativeNow }
})

for (const payload of [{}, { injuries: [] }, { injuries: [{ injuries: [injury('Scratch', 'Unknown')] }] }, { injuries: [{}] }]) {
  Deno.test(`degraded injuries preserve existing designations: ${JSON.stringify(payload)}`, async () => {
    const result = await refresh(payload, [player('scratch', 'Afternoon Scratch', 'Out')])
    assert.equal(result.response.status, 500)
    assert.deepEqual(result.writes, [])
    assert.equal(result.runs.at(-1)?.status, 'failed')
  })
}

Deno.test('an unlisted player keeps Out and does not make a current player name ambiguous', async () => {
  const result = await refresh({ injuries: [{ injuries: [injury('Same Name')] }] }, [
    player('current', 'Same Name'), { ...player('unlisted', 'Same Name Jr.', 'Out'), nba_team: null },
  ])
  assert.equal(result.response.status, 200)
  assert.deepEqual(result.writes, [{ id: 'eq.current', body: { injury_status: 'Out', injury_reason: 'unknown', injury_expected_return: 'unknown' } }])
})

Deno.test('an unlisted player absent from the injury feed keeps Out', async () => {
  const result = await refresh({ injuries: [{ injuries: [injury('Other Name')] }] }, [
    { ...player('unlisted', 'Unlisted Player', 'Out'), nba_team: null },
  ])
  assert.equal(result.response.status, 200)
  assert.deepEqual(result.writes, [])
})

Deno.test('an HTTP injury failure refuses all injury writes', async () => {
  const result = await refresh(new Response('unavailable', { status: 500 }))
  assert.equal(result.response.status, 500)
  assert.deepEqual(result.writes, [])
  assert.equal(result.runs.at(-1)?.status, 'failed')
})

for (const [token, status] of [[null, 401], ['wrong-token', 403]] as const) {
  Deno.test(`injury refresh rejects unauthorized requests with ${status}`, async () => {
    const result = await refresh({}, [], {}, token)
    assert.equal(result.response.status, status)
    assert.deepEqual(result.requests, [])
  })
}

Deno.test('injury details update even when the status stays Out', async () => {
  const result = await refresh({ injuries: [{ injuries: [{ status: 'Out', athlete: { displayName: 'Afternoon Scratch' }, details: { type: 'Ankle', detail: 'Sprain', returnDate: '2026-11-02' } }] }] }, [player('scratch', 'Afternoon Scratch', 'Out')])
  assert.deepEqual(result.writes, [{ id: 'eq.scratch', body: { injury_status: 'Out', injury_reason: 'Ankle: Sprain', injury_expected_return: '2026-11-02' } }])
})

Deno.test('a returned injury failure logs its message and worker stack', async () => {
  const result = await refresh({ injuries: [] })
  assert.equal(result.response.status, 500)
  assert.ok(result.logs.some(log => log.includes('no mapped statuses') && log.includes('syncRuns.ts')))
})

Deno.test('a thrown injury failure logs its message and stack but keeps the HTTP body generic', async () => {
  const result = await refresh(new Response('unavailable', { status: 500 }))
  assert.equal(result.response.status, 500)
  assert.equal(result.result.error, 'Internal server error')
  assert.ok(result.logs.some(log => log.includes('ESPN injuries 500') && log.includes('playerSource.ts')))
})

Deno.test('a concurrent database lock retries the same guarded injury update', async () => {
  const result = await refresh({ injuries: [{ injuries: [injury('Afternoon Scratch')] }] }, [player('scratch', 'Afternoon Scratch')], {}, 'fixture-token', [{ code: '55P03', message: 'canceling statement due to lock timeout' }])
  assert.equal(result.response.status, 200)
  assert.equal(result.result.updated, 1)
  assert.equal(result.writes.length, 2)
  assert.deepEqual(result.writes[0], result.writes[1])
  assert.equal(result.writeFilters[0], result.writeFilters[1])
  assert.ok(result.writeFilters[1].includes('injury_status=is.null'))
})

Deno.test('a permanent injury write failure is reported without retrying', async () => {
  const result = await refresh({ injuries: [{ injuries: [injury('Afternoon Scratch')] }] }, [player('scratch', 'Afternoon Scratch')], {}, 'fixture-token', [{ code: '23514', message: 'check constraint failed' }])
  assert.equal(result.response.status, 500)
  assert.equal(result.writes.length, 1)
  assert.equal(result.result.updated, 0)
  assert.match(result.result.failure, /check constraint failed/)
})

Deno.test('persistent injury contention stops after five attempts and stays failed', async () => {
  const result = await refresh({ injuries: [{ injuries: [injury('Afternoon Scratch')] }] }, [player('scratch', 'Afternoon Scratch')], {}, 'fixture-token', Array.from({ length: 5 }, () => ({ code: '55P03', message: 'canceling statement due to lock timeout' })))
  assert.equal(result.response.status, 500)
  assert.equal(result.writes.length, 5)
  assert.match(result.result.failure, /lock timeout/)
})

Deno.test('a lost work lease prevents another injury write attempt', async () => {
  let renewals = 0
  const result = await withWorkContext({ signal: new AbortController().signal, renewLease: async () => {
    if (++renewals > 1) throw new Error('Work lease lost')
  } }, () => refresh({ injuries: [{ injuries: [injury('Afternoon Scratch')] }] }, [player('scratch', 'Afternoon Scratch')], {}, 'fixture-token', [{ code: '55P03', message: 'canceling statement due to lock timeout' }]))
  assert.equal(result.response.status, 500)
  assert.equal(result.writes.length, 1)
  assert.ok(result.logs.some(log => log.includes('Work lease lost')))
})

import { strict as assert } from 'node:assert'

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
const player = (id: string, display_name: string, injury_status: string | null = null) => ({ id, display_name, injury_status, espn_id: id, nba_team: 'BOS' })

async function refresh(payload: unknown, players: { id: string; display_name: string; injury_status: string | null; espn_id: string | null; nba_team: string | null }[] = [player('scratch', 'Afternoon Scratch')], body: unknown = {}, token: string | null = 'fixture-token') {
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  const writes: { id: string | null; body: Record<string, unknown> }[] = []
  const runs: Record<string, unknown>[] = []
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
    assert.equal(url.pathname, '/rest/v1/players')
    if (request.method === 'PATCH') {
      writes.push({ id: url.searchParams.get('id'), body: await request.json() })
      return Response.json([{ id: url.searchParams.get('id')?.slice(3) }])
    }
    return Response.json(players)
  }
  try {
    const response = await handler!(new Request('http://function.invalid', {
      method: 'POST', headers: { ...(token ? { 'x-internal-function-token': token } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))
    return { response, result: await response.json(), requests, writes, runs }
  } finally {
    globalThis.fetch = originalFetch
  }
}

Deno.test('an afternoon scratch updates the stored injury before the next lineup dispatch', async () => {
  const result = await refresh({ injuries: [{ injuries: [injury('Afternoon Scratch')] }] })
  assert.equal(result.response.status, 200)
  assert.deepEqual(result.writes, [{ id: 'eq.scratch', body: { injury_status: 'Out' } }])
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
    { id: 'eq.scratch', body: { injury_status: 'Out' } }, { id: 'eq.recovered', body: { injury_status: null } },
  ])
})

Deno.test('a shared name never changes either player injury', async () => {
  const result = await refresh({ injuries: [{ injuries: [injury('Same Name')] }] }, [
    player('one', 'Same Name', 'Out'), player('two', 'Same Name Jr.'),
  ])
  assert.equal(result.response.status, 200)
  assert.deepEqual(result.writes, [])
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
  assert.deepEqual(result.writes, [{ id: 'eq.current', body: { injury_status: 'Out' } }])
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

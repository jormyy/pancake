import { strict as assert } from 'node:assert'

for (const [key, value] of Object.entries({
  SUPABASE_URL: 'http://database.invalid', PANCAKE_SUPABASE_SECRET_KEY: 'fixture-key',
  PANCAKE_EDGE_INTERNAL_TOKEN: 'fixture-token', NBA_CDN_BASE_URL: 'http://nba.invalid',
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

Deno.test('schedule publication reports its receipt without reading stored games', async () => {
  const originalFetch = globalThis.fetch
  const reads: string[] = []
  let publication: Record<string, unknown> | undefined
  let finished: Record<string, unknown> | undefined
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.hostname === 'nba.invalid') return Response.json({ leagueSchedule: { seasonYear: '2026-27', gameDates: [{
      games: [{ gameId: '0022600001', gameDateEst: '2026-10-25T00:00:00Z', gameDateTimeUTC: '2026-10-25T23:00:00Z',
        gameStatus: 1, homeTeam: { teamTricode: 'BOS' }, awayTeam: { teamTricode: 'NYK' } }],
    }] } })
    assert.equal(url.hostname, 'database.invalid')
    if (url.pathname === '/rest/v1/sync_runs') {
      if (request.method === 'POST') return Response.json({ id: 'run' })
      finished = await request.json()
      return Response.json({})
    }
    if (url.pathname === '/rest/v1/nba_games') {
      reads.push(url.href)
      return Response.json([])
    }
    assert.equal(url.pathname, '/rest/v1/rpc/publish_nba_schedule_atomic')
    publication = await request.json()
    return Response.json(7)
  }
  try {
    const response = await handler!(new Request('http://function.invalid', {
      method: 'POST', headers: { 'x-internal-function-token': 'fixture-token' },
    }))
    assert.equal(response.status, 200)
    assert.deepEqual(reads, [])
    assert.equal(publication?.p_season_year, 2027)
    assert.equal((publication?.p_games as unknown[])?.length, 1)
    assert.deepEqual(await response.json(), { ok: true, games: 1, weeks: 7 })
    assert.equal(finished?.rows_affected, 8)
  } finally {
    globalThis.fetch = originalFetch
  }
})

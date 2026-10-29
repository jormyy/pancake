import { strict as assert } from 'node:assert'
import { withWorkContext } from '../_shared/workContext.ts'
import { etDateKey, seasonYearForGameDate } from '../_shared/schedule.ts'

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
  const gameDate = etDateKey(new Date(Date.now() + 24 * 60 * 60 * 1000))
  const seasonYear = seasonYearForGameDate(gameDate)
  const seasonLabel = `${seasonYear - 1}-${String(seasonYear).slice(-2)}`
  const originalFetch = globalThis.fetch
  const reads: string[] = []
  let publication: Record<string, unknown> | undefined
  let finished: Record<string, unknown> | undefined
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.hostname === 'nba.invalid') return Response.json({ leagueSchedule: { seasonYear: seasonLabel, gameDates: [{
      games: [{ gameId: '0022600001', gameDateEst: `${gameDate}T00:00:00Z`, gameDateTimeUTC: `${gameDate}T23:00:00Z`,
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
    assert.equal(publication?.p_season_year, seasonYear)
    assert.equal((publication?.p_games as unknown[])?.length, 1)
    assert.deepEqual(await response.json(), { ok: true, games: 1, weeks: 7 })
    assert.equal(finished?.rows_affected, 8)
  } finally {
    globalThis.fetch = originalFetch
  }
})

for (const code of ['PT409', '55P03', '40P01', '40001', '57014', '55000', 'persistent', 'lease_lost']) {
  Deno.test(`schedule ${code} failures keep guards and retry only transient publication errors`, async () => {
    const gameDate = etDateKey(new Date(Date.now() + 24 * 60 * 60 * 1000))
    const seasonYear = seasonYearForGameDate(gameDate)
    const native = globalThis.fetch
    const publications: unknown[] = []
    let sources = 0
    let leaseChecks = 0
    let finished: Record<string, unknown> | undefined
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url)
      if (url.hostname === 'nba.invalid') {
        sources++
        return Response.json({ leagueSchedule: { seasonYear: `${seasonYear - 1}-${String(seasonYear).slice(-2)}`, gameDates: [{ games: [{
          gameId: '0022600001', gameDateEst: `${gameDate}T00:00:00Z`, gameDateTimeUTC: `${gameDate}T23:00:00Z`,
          gameStatus: 1, homeTeam: { teamTricode: 'BOS' }, awayTeam: { teamTricode: 'NYK' },
        }] }] } })
      }
      assert.equal(url.hostname, 'database.invalid')
      if (url.pathname === '/rest/v1/sync_runs') {
        if (request.method === 'POST') return Response.json({ id: 'run' })
        finished = await request.json()
        return Response.json({})
      }
      assert.equal(url.pathname, '/rest/v1/rpc/publish_nba_schedule_atomic')
      publications.push(await request.json())
      if (publications.length === 1 || code === 'persistent' || code === '55000') {
        return Response.json({ code: ['persistent', 'lease_lost'].includes(code) ? 'PT409' : code, message: 'Schedule publication blocked' }, { status: 500 })
      }
      return Response.json(7)
    }
    try {
      const run = () => handler!(new Request('http://function.invalid', {
        method: 'POST', headers: { 'x-internal-function-token': 'fixture-token' },
      }))
      const response = code === 'lease_lost' ? await withWorkContext({
        signal: new AbortController().signal,
        renewLease: () => { leaseChecks++; return Promise.reject(new Error('Work lease lost')) },
      }, run) : await run()
      const transient = !['55000', 'persistent', 'lease_lost'].includes(code)
      assert.equal(response.status, transient ? 200 : 500)
      assert.equal(publications.length, transient ? 2 : code === 'persistent' ? 3 : 1)
      assert.equal(sources, 1)
      assert.equal(leaseChecks, code === 'lease_lost' ? 1 : 0)
      for (const publication of publications) assert.deepEqual(publication, publications[0])
      assert.equal(finished?.status, transient ? 'success' : 'failed')
    } finally { globalThis.fetch = native }
  })
}

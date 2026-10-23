import { strict as assert } from 'node:assert'

// The release decision through the real sync-players handler: only a listing
// with no gaps (every NBA team, identifiable athletes, every record imported)
// sends the espn_release call, after every import chunk; anything less
// releases nobody. The call's receipt names who it released (a stored box
// placed them in a game their team did not play) and who it held (ESPN omits
// them: unproven if ESPN claimed them, unclaimed if not), and the run reports
// both.
for (const [name, value] of Object.entries({
  SUPABASE_URL: 'http://database.invalid',
  PANCAKE_SUPABASE_SECRET_KEY: 'fixture-key',
  PANCAKE_EDGE_INTERNAL_TOKEN: 'fixture-internal-token',
  EDGE_FUNCTION_INTERNAL_TOKEN: 'fixture-internal-token',
  ESPN_SITE_BASE_URL: 'http://espn.invalid/api',
  NBA_CDN_BASE_URL: 'http://nba.invalid/static/json',
  PLAYER_SYNC_SOURCE: 'espn',
})) Deno.env.set(name, value)

type Handler = (request: Request) => Promise<Response>
let handler: Handler | undefined
const serveDescriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
try {
  Object.defineProperty(Deno, 'serve', { value: (serve: Handler) => { handler = serve } })
  await import('./index.ts')
} finally {
  Object.defineProperty(Deno, 'serve', serveDescriptor)
}

const codes = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GS', 'HOU', 'IND', 'LAC', 'LAL', 'MEM',
  'MIA', 'MIL', 'MIN', 'NO', 'NY', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SA', 'TOR', 'UTAH', 'WSH']
const players = Array.from({ length: 634 }, (_, index) => ({ id: String(1000 + index), team: index % 30, last: `Player${index}` }))

type Feed = { teams?: string[]; emptyRoster?: string; nameless?: string; failChunk?: boolean; conflict?: string; release?: 'error' | 'invalid' | 'unheld' }

async function runSync(feed: Feed = {}) {
  const originalFetch = globalThis.fetch
  const originalLog = console.log
  const originalError = console.error
  const calls: { source: string; ids: string[] }[] = []
  const runs: { status: string; error?: string; rows_affected?: number }[] = []
  const teams = feed.teams ?? codes
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.hostname === 'espn.invalid') {
      if (url.pathname === '/api/teams') {
        return Response.json({ sports: [{ leagues: [{ teams: teams.map((abbreviation) => ({ team: { id: String(codes.indexOf(abbreviation)), abbreviation } })) }] }] })
      }
      const team = url.pathname.match(/^\/api\/teams\/(\d+)\/roster$/)
      if (team) {
        const code = codes[Number(team[1])]
        const listed = code === feed.emptyRoster ? [] : players.filter((player) => player.team === Number(team[1]))
        return Response.json({ athletes: [
          ...listed.map((player) => ({ id: player.id, firstName: 'Fixture', lastName: player.last, position: { abbreviation: 'PG' }, status: { type: 'active' } })),
          ...code === feed.nameless ? [{ id: 'nameless' }] : [],
        ] })
      }
      if (url.pathname === '/api/injuries') return Response.json({ injuries: [] })
      if (url.pathname === '/api/news') return Response.json({ articles: [] })
    }
    if (url.hostname === 'nba.invalid' && url.pathname === '/static/json/staticData/playerIndex.json') {
      return Response.json({ resultSets: [{ headers: ['PERSON_ID', 'PLAYER_FIRST_NAME', 'PLAYER_LAST_NAME', 'ROSTER_STATUS'], rowSet: [] }] })
    }
    assert.equal(url.hostname, 'database.invalid', `Unexpected request ${url.hostname}${url.pathname}`)
    if (url.pathname === '/rest/v1/sync_runs') {
      if (request.method === 'POST') return Response.json({ id: 'fixture-run' })
      runs.push(await request.json())
      return Response.json({})
    }
    if (url.pathname === '/rest/v1/players') return Response.json([])
    if (url.pathname === '/rest/v1/rpc/merge_duplicate_players') return Response.json(null)
    assert.equal(url.pathname, '/rest/v1/rpc/resolve_player_imports_atomic')
    const body = await request.json() as { p_source: string; p_records: { provider_id: string; metadata?: unknown }[] }
    const ids = body.p_records.map((row) => row.provider_id)
    calls.push({ source: body.p_source, ids })
    if (body.p_source === 'espn_release') {
      assert.ok(body.p_records.every((row) => !('metadata' in row)), 'A release names players; it carries no metadata')
      if (feed.release === 'error') return Response.json({ code: '22023', message: 'A release needs the complete ESPN listing.' }, { status: 400 })
      const released = ['released-1', 'released-2'], held = { unproven: ['held-1'], unclaimed: ['held-2', 'held-3'] }
      return Response.json(feed.release === 'invalid' ? { results: [] } : feed.release === 'unheld' ? { released } : { released, held })
    }
    assert.equal(body.p_source, 'espn')
    if (feed.failChunk && calls.length === 1) return Response.json({ code: '22023', message: 'Player name is empty.' }, { status: 400 })
    if (feed.conflict && ids.includes(feed.conflict)) {
      return Response.json({ code: '23514', message: 'Conflicting provider identity for player 00000000-0000-4000-8000-000000000123' }, { status: 400 })
    }
    return Response.json({ results: ids.map((id, index) => ({ index, player_id: `player-${id}`, action: 'updated' })), stale_draft_numbers_cleared: 0 })
  }
  try {
    console.log = () => undefined
    console.error = () => undefined
    const response = await handler!(new Request('http://function.invalid/sync-players', {
      method: 'POST', headers: { 'x-internal-function-token': 'fixture-internal-token' },
    }))
    const body = await response.json() as { released?: number; releaseSkipped?: string[]; releaseHeld?: { unproven: number; unclaimed: number } }
    return { status: response.status, body, calls, run: runs.at(-1) }
  } finally {
    globalThis.fetch = originalFetch
    console.log = originalLog
    console.error = originalError
  }
}

const releases = <Call extends { source: string }>(calls: Call[]) => calls.filter((call) => call.source === 'espn_release')

Deno.test('a complete refresh releases with every listed player after every import chunk', async () => {
  const result = await runSync()
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.deepEqual(result.calls.map((call) => call.source), ['espn', 'espn', 'espn_release'])
  assert.deepEqual([...releases(result.calls)[0].ids].sort(), players.map((player) => player.id).sort())
  assert.equal(result.body.released, 2)
  assert.deepEqual(result.body.releaseHeld, { unproven: 1, unclaimed: 2 })
  assert.deepEqual(result.body.releaseSkipped, [])
  assert.equal(result.run?.status, 'success')
  assert.equal(result.run?.rows_affected, 634 + 2)
})

const incomplete: [string, Feed, number, string][] = [
  ['a team missing from the teams payload', { teams: codes.filter((code) => code !== 'MIN') }, 200, 'missing roster MIN'],
  ['an empty roster page', { emptyRoster: 'UTAH' }, 200, 'empty roster UTA'],
  ['an athlete the import cannot key', { nameless: 'GS' }, 200, '1 unidentified athlete(s) on GSW'],
  ['a failed import chunk', { failChunk: true }, 500, '1 import failure(s)'],
  ['one record with a conflicting identity', { conflict: '1123' }, 500, '1 import failure(s)'],
]
for (const [label, feed, status, blocker] of incomplete) {
  Deno.test(`${label} releases nobody`, async () => {
    const result = await runSync(feed)
    assert.equal(result.status, status)
    assert.deepEqual(releases(result.calls), [])
    assert.ok(result.calls.length > 0, 'the import itself still runs')
    assert.ok(result.body.releaseSkipped?.includes(blocker), JSON.stringify(result.body.releaseSkipped))
    assert.equal(result.body.released, 0)
    assert.deepEqual(result.body.releaseHeld, { unproven: 0, unclaimed: 0 })
  })
}

for (const [label, release, error] of [['a refused release', 'error', /release: .*complete ESPN listing/], ['an invalid release receipt', 'invalid', /release: Invalid release receipt/],
  ['a receipt without its held players', 'unheld', /release: Invalid release receipt/]] as const) {
  Deno.test(`${label} fails the run after a complete import`, async () => {
    const result = await runSync({ release })
    assert.equal(result.status, 500)
    assert.equal(releases(result.calls).length, 1)
    assert.equal(result.run?.status, 'failed')
    assert.match(result.run?.error ?? '', error)
  })
}

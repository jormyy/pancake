// Draft-order automation degraded modes: a failed scrape day writes nothing
// and the next scheduled window day succeeds; a fully-failed window leaves
// the prior order intact (no half-written board).

type MockPlayer = {
  id: string
  display_name: string
  first_name: string
  last_name: string
  years_exp: number
  nba_draft_number: number | null
}

// 60 existing players matching the mock draft board, plus one player holding
// last year's draft number who is NOT in the new draft (stale -> cleared).
const players: MockPlayer[] = Array.from({ length: 60 }, (_, index) => ({
  id: `player-${index + 1}`,
  display_name: `Mock Rookie ${index + 1}`,
  first_name: 'Mock',
  last_name: `Rookie ${index + 1}`,
  years_exp: 0,
  nba_draft_number: null,
}))
const priorOrderSnapshot = () => players.map((player) => player.nba_draft_number)

let upstreamMode: 'down' | 'partial' | 'good' = 'down'
const writes: string[] = []

const statsPayload = (count: number) => ({
  resultSets: [{
    headers: ['PLAYER_NAME', 'OVERALL_PICK', 'ROUND_NUMBER', 'ROUND_PICK', 'TEAM_NAME'],
    rowSet: Array.from({ length: count }, (_, index) => [
      `Mock Rookie ${index + 1}`,
      index + 1,
      index < 30 ? 1 : 2,
      index < 30 ? index + 1 : index - 29,
      'Mock Team',
    ]),
  }],
})

const upstream = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, (req) => {
  const url = new URL(req.url)
  if (upstreamMode === 'down') return new Response('nope', { status: 503 })
  if (url.pathname.startsWith('/stats/drafthistory')) {
    return Response.json(statsPayload(upstreamMode === 'partial' ? 20 : 60))
  }
  // nba.com article pages: not found so the stats fallback is exercised.
  return new Response('not found', { status: 404 })
})

const postgrest = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (req) => {
  const url = new URL(req.url)
  if (url.pathname !== '/rest/v1/players') return Response.json([])

  if (req.method === 'PATCH') {
    writes.push(url.search)
    const id = url.searchParams.get('id')?.replace('eq.', '')
    const body = await req.json()
    const player = players.find((row) => row.id === id)
    if (player && 'nba_draft_number' in body) player.nba_draft_number = body.nba_draft_number
    if (player && 'years_exp' in body) player.years_exp = body.years_exp
    return Response.json([])
  }
  if (req.method === 'POST') {
    writes.push('insert')
    return Response.json([])
  }

  if (url.searchParams.get('years_exp') === 'eq.0' && url.searchParams.get('nba_draft_number') === 'not.is.null') {
    return Response.json(players.filter((row) => row.years_exp === 0 && row.nba_draft_number != null))
  }
  return Response.json(players)
})

Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(postgrest.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
Deno.env.set('NBA_STATS_BASE_URL', `http://127.0.0.1:${(upstream.addr as Deno.NetAddr).port}`)
Deno.env.set('NBA_COM_BASE_URL', `http://127.0.0.1:${(upstream.addr as Deno.NetAddr).port}`)

const { syncDraftOrder, defaultDraftOrderSeasonYear } = await import('./lib.ts')

Deno.test({
  name: 'a fully-failed window day writes nothing and leaves the prior order intact',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    upstreamMode = 'down'
    const before = priorOrderSnapshot()
    let threw = false
    try {
      await syncDraftOrder(2027)
    } catch {
      threw = true
    }
    if (!threw) throw new Error('down upstream did not fail the sync')
    if (writes.length > 0) throw new Error(`down upstream produced writes: ${writes.join(', ')}`)
    if (JSON.stringify(priorOrderSnapshot()) !== JSON.stringify(before)) {
      throw new Error('prior draft order changed on a failed day')
    }
  },
})

Deno.test({
  name: 'an incomplete board is refused, never half-written',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    upstreamMode = 'partial'
    let message = ''
    try {
      await syncDraftOrder(2027)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    if (!/Could not load a complete/.test(message)) {
      throw new Error(`partial board not refused: ${message || 'no error'}`)
    }
    if (writes.length > 0) throw new Error('partial board produced writes')
  },
})

Deno.test({
  name: 'the next scheduled window day succeeds and syncs the full board',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    upstreamMode = 'good'
    const result = await syncDraftOrder(2027)
    if (result.draftPickCount !== 60 || result.updated !== 60) {
      throw new Error(`unexpected sync result: ${JSON.stringify(result)}`)
    }
    const numbered = players.filter((row) => row.nba_draft_number != null)
    if (numbered.length !== 60) throw new Error(`board half-written: ${numbered.length} players numbered`)
  },
})

Deno.test('the June/July window guard refuses other months without a seasonYear', () => {
  let threw = false
  try {
    defaultDraftOrderSeasonYear(new Date('2026-10-10T12:00:00Z'))
  } catch {
    threw = true
  }
  if (!threw) throw new Error('window guard did not refuse October')
  const year = defaultDraftOrderSeasonYear(new Date('2026-06-25T12:00:00Z'))
  if (year !== 2026) throw new Error(`unexpected June season year ${year}`)
})

Deno.test({
  name: 'close draft-order mocks',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await upstream.shutdown()
    await postgrest.shutdown()
  },
})

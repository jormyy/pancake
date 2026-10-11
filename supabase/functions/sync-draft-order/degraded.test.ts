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

type UpstreamMode = 'down' | 'partial' | 'good' | 'malformed-article' | 'bare-number' | 'out-of-range' | 'negative-number' | 'large-unpunctuated' | 'numbered-bullet' | 'invalid-stats' | 'empty-name' | 'malformed-row' | 'gapped-article' | 'valid50' | 'article-fallback'
let upstreamMode: UpstreamMode = 'down'
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
    if (upstreamMode === 'malformed-article' || upstreamMode === 'bare-number' || upstreamMode === 'out-of-range' || upstreamMode === 'negative-number' || upstreamMode === 'large-unpunctuated' || upstreamMode === 'numbered-bullet' || upstreamMode === 'gapped-article' || upstreamMode === 'valid50') {
      return new Response('not found', { status: 404 })
    }
    const payload = statsPayload(upstreamMode === 'partial' ? 20 : 60)
    const rows = payload.resultSets[0].rowSet as unknown[][]
    if (upstreamMode === 'invalid-stats') rows[36][1] = null
    if (upstreamMode === 'empty-name') rows[36][0] = '   '
    if (upstreamMode === 'malformed-row') rows[36] = []
    return Response.json(payload)
  }
  if (['malformed-article', 'bare-number', 'out-of-range', 'negative-number', 'large-unpunctuated', 'numbered-bullet', 'gapped-article', 'valid50', 'article-fallback'].includes(upstreamMode)) {
    const articlePlayers = upstreamMode === 'valid50' ? players.slice(0, 50) : players
    const verbs = ['draft', 'drafts', 'select', 'selects', 'take', 'takes', 'pick', 'picks', 'from']
    const lines = articlePlayers.flatMap((player, index) => {
      if (upstreamMode === 'gapped-article' && index === 36) return []
      if (upstreamMode === 'bare-number' && index === 36) return ['37']
      if (upstreamMode === 'out-of-range' && index === 36) return ['137. Mock Team selects Mock Rookie 37']
      if (upstreamMode === 'negative-number' && index === 36) return ['-37. Mock Team selects Mock Rookie 37']
      if (upstreamMode === 'large-unpunctuated' && index === 36) return ['137 Mock Team selects Mock Rookie 37']
      if (upstreamMode === 'numbered-bullet' && index === 36) return ['- 37. Mock Team selects Mock Rookie 37']
      const malformed = upstreamMode === 'malformed-article' || upstreamMode === 'article-fallback'
      const verb = index === 36 && malformed ? 'chooses' : upstreamMode === 'valid50' ? verbs[index % verbs.length] : 'selects'
      return [`${index + 1}. Mock Team ${verb} ${player.display_name}`]
    })
    return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { article: { contentText: lines.join('\n') } } },
    })}</script>`, { headers: { 'content-type': 'text/html' } })
  }
  // Other article pages are missing so the stats fallback is exercised.
  return new Response('not found', { status: 404 })
})

const postgrest = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (req) => {
  const url = new URL(req.url)
  if (url.pathname === '/rest/v1/rpc/resolve_player_imports_atomic') {
    const body = await req.json()
    if (body.p_source !== 'nba_draft') throw new Error('Unexpected import source')
    writes.push('atomic draft import')
    for (const player of players) player.nba_draft_number = null
    const results = body.p_records.map((pick: {display_name: string; nba_draft_number: number}, index: number) => {
      const player = players.find((row) => row.display_name === pick.display_name)
      if (!player) throw new Error('Fixture player missing')
      player.nba_draft_number = pick.nba_draft_number
      player.years_exp = 0
      return { index, player_id: player.id, action: 'updated' }
    })
    return Response.json({ results, stale_draft_numbers_cleared: 0 })
  }
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
// The 2027 board is the latest class from June 2027 on.
const DRAFT_WINDOW = new Date('2027-06-25T12:00:00Z')

Deno.test({
  name: 'a fully-failed window day writes nothing and leaves the prior order intact',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    upstreamMode = 'down'
    const before = priorOrderSnapshot()
    let threw = false
    try {
      await syncDraftOrder(2027, DRAFT_WINDOW)
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
      await syncDraftOrder(2027, DRAFT_WINDOW)
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
    const result = await syncDraftOrder(2027, DRAFT_WINDOW)
    if (result.draftPickCount !== 60 || result.updated !== 60) {
      throw new Error(`unexpected sync result: ${JSON.stringify(result)}`)
    }
    const numbered = players.filter((row) => row.nba_draft_number != null)
    if (numbered.length !== 60) throw new Error(`board half-written: ${numbered.length} players numbered`)
  },
})

for (const mode of ['malformed-article', 'bare-number', 'out-of-range', 'negative-number', 'large-unpunctuated', 'numbered-bullet', 'invalid-stats', 'empty-name', 'malformed-row'] as const) {
  Deno.test({
    name: `${mode}: one malformed row in a 60-pick response preserves the whole prior board`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      upstreamMode = mode
      const before = priorOrderSnapshot(), writesBefore = writes.length
      let message = ''
      try { await syncDraftOrder(2027, DRAFT_WINDOW) } catch (error) { message = String(error) }
      if (!/Could not load a complete/.test(message)) throw new Error(`Malformed row accepted: ${message}`)
      if (writes.length !== writesBefore) throw new Error('Malformed provider response caused an import')
      if (JSON.stringify(priorOrderSnapshot()) !== JSON.stringify(before)) throw new Error('Prior board changed')
    },
  })
}

Deno.test({
  name: 'a valid 59-pick board with a numbering gap remains supported',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    upstreamMode = 'gapped-article'
    const writesBefore = writes.length
    const result = await syncDraftOrder(2027, DRAFT_WINDOW)
    if (result.draftPickCount !== 59 || result.source !== 'nba.com' || writes.length !== writesBefore + 1) {
      throw new Error(`Valid gapped board rejected: ${JSON.stringify(result)}`)
    }
    if (players[36].nba_draft_number !== null || players[59].nba_draft_number !== 60) {
      throw new Error('Valid gapped board was renumbered')
    }
  },
})

Deno.test({
  name: 'the 50-record minimum and all recognized selection words remain supported',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    upstreamMode = 'valid50'
    const writesBefore = writes.length
    const result = await syncDraftOrder(2027, DRAFT_WINDOW)
    if (result.draftPickCount !== 50 || result.source !== 'nba.com' || writes.length !== writesBefore + 1) {
      throw new Error(`Valid minimum board rejected: ${JSON.stringify(result)}`)
    }
    if (players.some((player, index) => player.nba_draft_number !== (index < 50 ? index + 1 : null))) {
      throw new Error('Minimum board changed pick identities')
    }
  },
})

Deno.test({
  name: 'malformed article retries a complete independent stats source',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    upstreamMode = 'article-fallback'
    const writesBefore = writes.length
    const result = await syncDraftOrder(2027, DRAFT_WINDOW)
    if (result.draftPickCount !== 60 || result.source !== 'stats.nba.com' || writes.length !== writesBefore + 1) {
      throw new Error(`Independent complete fallback not used: ${JSON.stringify(result)}`)
    }
    if (players.some((player, index) => player.nba_draft_number !== index + 1)) {
      throw new Error('Fallback lost a pick')
    }
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
  name: 'a past or future class board is refused before any provider request or write',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    upstreamMode = 'good'
    const before = priorOrderSnapshot(), writesBefore = writes.length
    for (const year of [2026, 2028]) {
      let message = ''
      try { await syncDraftOrder(year, DRAFT_WINDOW) } catch (error) { message = String(error) }
      if (!/only the latest draft class \(2027\)/.test(message)) throw new Error(`${year} board was not refused: ${message}`)
    }
    if (writes.length !== writesBefore) throw new Error('A refused board caused an import')
    if (JSON.stringify(priorOrderSnapshot()) !== JSON.stringify(before)) throw new Error('A refused board changed draft numbers')
  },
})

Deno.test({
  name: 'the latest class can still be re-synced outside the June/July window',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    upstreamMode = 'good'
    const result = await syncDraftOrder(2027, new Date('2028-01-15T12:00:00Z'))
    if (result.draftPickCount !== 60) throw new Error(`latest class re-sync failed: ${JSON.stringify(result)}`)
  },
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

const calls: { name: string; body: Record<string, unknown> }[] = []
let failure: 'none' | 'legacy' | 'generic' | 'wrong-code' | 'reject-legacy' = 'none'
const legacyMessage = 'The proposed regular schedule does not match the saved playoff start. Reload settings and retry.'
const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async req => {
  const url = new URL(req.url)
  if (url.pathname.endsWith('/league_members')) {
    const league = url.searchParams.get('league_id')
    return Response.json(league === 'eq.solo' ? [{ id: 'one' }]
      : league === 'eq.odd' ? [{ id: 'one' }, { id: 'two' }, { id: 'three' }] : [{ id: 'one' }, { id: 'two' }])
  }
  if (req.method === 'POST') {
    const body = await req.json()
    calls.push({ name: url.pathname.split('/').at(-1)!, body })
    if ((failure === 'legacy' || failure === 'reject-legacy') && !('p_matchups' in body)) {
      return Response.json({ message: legacyMessage, code: 'P0001' }, { status: 400 })
    }
    if (failure === 'wrong-code') return Response.json({ message: legacyMessage, code: 'XX000' }, { status: 400 })
    if (failure === 'generic' || failure === 'reject-legacy') {
      return Response.json({ message: 'schedule unavailable', code: 'P0001' }, { status: 400 })
    }
    return Response.json({})
  }
  return new Response(JSON.stringify([
    { id: 'season-a', league_id: 'league-a', leagues: { playoff_start_week: 15 } },
    { id: 'season-b', league_id: 'league-b', leagues: null },
  ]), { headers: { 'content-type': 'application/json' } })
})
Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
const { generateMatchups, generateAllMatchups } = await import('./matchups.ts')
function assert(value: boolean): void { if (!value) throw new Error('Schedule delegation failed') }
Deno.test({ name: 'SQL owns schedule order and saved settings', sanitizeOps: false, sanitizeResources: false, fn: async () => {
  try {
    await generateMatchups('league-a', 'season-a', 19, true)
    assert(calls[0].name === 'replace_regular_season_matchups_atomic')
    assert(JSON.stringify(calls[0].body) === JSON.stringify({ p_league_id: 'league-a', p_league_season_id: 'season-a', p_force: true }))
    calls.length = 0
    await generateAllMatchups()
    assert(calls.length === 2 && calls.every(call => call.body.p_force === false && !('p_matchups' in call.body)))
    await generateMatchups('solo', 'season-solo', 19)
    assert(calls.length === 2)
    calls.length = 0
    failure = 'legacy'
    await generateMatchups('league-a', 'season-a', 19, true)
    assert(calls.length === 2 && !('p_matchups' in calls[0].body))
    const rows = calls[1].body.p_matchups
    assert(Array.isArray(rows) && rows.length === 19 && calls[1].body.p_force === true
      && rows.every((row, index) => row.league_id === 'league-a' && row.league_season_id === 'season-a'
      && row.week_number === index + 1 && row.home_member_id === 'one' && row.away_member_id === 'two'
      && row.matchup_type === 'regular_season'))
    calls.length = 0
    await generateMatchups('odd', 'season-odd', 4)
    const oddRows = calls[1].body.p_matchups
    assert(calls.length === 2 && Array.isArray(oddRows) && oddRows.length === 4
      && oddRows.every((row, index) => row.week_number === index + 1 && row.home_member_id !== row.away_member_id)
      && new Set(oddRows.slice(0, 3).map(row => [row.home_member_id, row.away_member_id].sort().join(':'))).size === 3)
    for (const mode of ['generic', 'wrong-code', 'reject-legacy'] as const) {
      calls.length = 0
      failure = mode
      let rejected = false
      try { await generateMatchups('league-a', 'season-a', 19) } catch { rejected = true }
      assert(rejected && calls.length === (mode === 'reject-legacy' ? 2 : 1))
    }
  } finally {
    await server.shutdown()
  }
} })

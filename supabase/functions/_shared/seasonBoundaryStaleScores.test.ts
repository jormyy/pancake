import { strict as assert } from 'node:assert'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'boundary-stale-test')
const { runSeasonBoundary } = await import('./seasonBoundary.ts')

for (const action of ['generate', 'advance', 'rollover']) {
  Deno.test(`${action} replays stale scores before applying the season boundary`, async () => {
    const nativeFetch = globalThis.fetch
    const calls: string[] = []
    let stale = true
    const matchup = { id: 'matchup', matchup_type: action === 'generate' ? 'regular_season'
      : action === 'advance' ? 'playoff_semifinal' : 'playoff_final', playoff_round: action === 'generate' ? null : 1,
      week_number: 1, end_week_number: null, is_finalized: true, finalized_at: '2026-02-01T00:00:00Z',
      winner_member_id: 'home', home_member_id: 'home', away_member_id: 'away', home_points: 0, away_points: 0,
      home_max_possible_points: null, away_max_possible_points: null }
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input)
      const table = url.pathname.split('/').at(-1)!
      calls.push(table)
      const select = url.searchParams.get('select') ?? ''
      if (table === 'league_seasons') {
        if (select === 'season_year') return Response.json({ season_year: 2026 })
        if (url.searchParams.has('id')) return Response.json({ is_current: true })
        return Response.json([{ id: 'season', league_id: 'league', season_year: 2026, is_current: true,
          leagues: { status: action === 'generate' ? 'active' : 'playoffs', playoff_start_week: 2, scoring_settings: {} } }])
      }
      if (table === 'matchups') return Response.json(url.searchParams.get('is_finalized') === 'eq.false' ? [] : [matchup])
      if (table === 'season_weeks') {
        const week = { week_number: 1, week_start: '2026-02-01', week_end: '2026-02-07' }
        return Response.json(url.searchParams.get('week_number')?.startsWith('eq.') ? week : [week])
      }
      if (table === 'nba_games' || table === 'get_score_sync_games') return Response.json([])
      if (table === 'get_stale_score_weeks') {
        const body = JSON.parse(String(init?.body))
        assert.deepEqual(body, { p_league_season_id: 'season', p_through_week: 1 })
        return Response.json(stale ? [{ week_number: 1 }] : [])
      }
      if (table === 'capture_score_inputs') return Response.json({ token: 1 })
      if (table === 'leagues') return Response.json({ scoring_settings: {} })
      if (table === 'league_members') return Response.json([{ id: 'home' }, { id: 'away' }])
      if (table === 'finalize_score_week_atomic') { stale = false; return Response.json([]) }
      if (table === 'apply_season_boundary_after_grace') {
        assert.equal(stale, false, 'the SQL boundary must see refreshed score certificates')
        return Response.json({ applied: true })
      }
      return Response.json([])
    }
    try {
      const result = await runSeasonBoundary(new Date('2026-02-10T14:00:00Z'))
      assert.equal(result[0].error, undefined)
      assert.deepEqual(result[0].actions, [action === 'generate' ? 'bracket-generated'
        : action === 'advance' ? 'final-created' : 'season-advanced'])
      assert.ok(calls.includes('finalize_score_week_atomic'), 'stale scores must be replayed')
      assert.ok(calls.indexOf('get_stale_score_weeks') < calls.indexOf('finalize_score_week_atomic'))
      assert.ok(calls.indexOf('finalize_score_week_atomic') < calls.indexOf('apply_season_boundary_after_grace'))
      assert.equal(calls.filter(table => table === 'nba_games').length, action === 'rollover' ? 0 : 1)
    } finally { globalThis.fetch = nativeFetch }
  })
}

Deno.test('a boundary still blocked by stale score inputs records a retryable failure', async () => {
  const nativeFetch = globalThis.fetch
  globalThis.fetch = (input) => {
    const table = new URL(input instanceof Request ? input.url : input).pathname.split('/').at(-1)
    if (table === 'league_seasons') return Promise.resolve(Response.json([{ id: 'season', league_id: 'league',
      leagues: { status: 'playoffs', playoff_start_week: 2 } }]))
    if (table === 'matchups') return Promise.resolve(Response.json([{ matchup_type: 'playoff_final', week_number: 2,
      is_finalized: true, finalized_at: '2026-02-01T00:00:00Z', winner_member_id: 'winner' }]))
    if (table === 'get_stale_score_weeks') return Promise.resolve(Response.json([]))
    if (table === 'apply_season_boundary_after_grace') return Promise.resolve(Response.json({ applied: false, reason: 'stale_score_inputs', retryable: true }))
    throw new Error(`Unexpected request ${table}`)
  }
  try {
    const result = await runSeasonBoundary(new Date('2026-02-10T14:00:00Z'))
    assert.match(result[0].error ?? '', /Score inputs are stale\. Retry/)
    assert.deepEqual(result[0].actions, [])
  } finally { globalThis.fetch = nativeFetch }
})

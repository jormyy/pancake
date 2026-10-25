import { strict as assert } from 'node:assert'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'boundary-round-test')
const { runSeasonBoundary } = await import('./seasonBoundary.ts')

for (const finalized of [true, false]) {
  Deno.test(`round advancement uses the last game date with finalized=${finalized}`, async () => {
    const nativeFetch = globalThis.fetch
    const calls: string[] = []
    const matchup = { id: 'matchup', matchup_type: 'playoff_semifinal', playoff_round: 1,
      week_number: 1, end_week_number: 2, is_finalized: finalized, finalized_at: finalized ? '2026-04-13T23:10:00Z' : null,
      winner_member_id: finalized ? 'home' : null, home_member_id: 'home', away_member_id: 'away',
      home_points: 0, away_points: 0, home_max_possible_points: null, away_max_possible_points: null }
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input)
      const table = url.pathname.split('/').at(-1)!
      calls.push(table)
      const select = url.searchParams.get('select') ?? ''
      if (table === 'league_seasons') {
        if (select === 'season_year') return Response.json({ season_year: 2026 })
        if (url.searchParams.has('id')) return Response.json({ is_current: true })
        return Response.json([{ id: 'season', league_id: 'league', season_year: 2026, is_current: true,
          leagues: { status: 'playoffs', playoff_start_week: 1, scoring_settings: {} } }])
      }
      if (table === 'matchups') return Response.json([matchup])
      if (table === 'season_weeks') {
        const week = { week_number: 2, week_start: '2026-04-06', week_end: '2026-04-12' }
        return Response.json(url.searchParams.get('week_number')?.startsWith('eq.') ? week : [
          { week_number: 1, week_start: '2026-03-30', week_end: '2026-04-05' }, week,
        ])
      }
      if (table === 'nba_games') return Response.json([
        { nba_game_id: '002round', game_date: '2026-04-12', status: 'Final', game_status_text: null },
        { nba_game_id: '002cancelled', game_date: '2026-04-13', status: 'Final', game_status_text: 'Cancelled' },
      ])
      if (table === 'get_score_sync_games' || table === 'get_stale_score_weeks') return Response.json([])
      if (table === 'capture_score_inputs') return Response.json({ token: 1 })
      if (table === 'leagues') return Response.json({ scoring_settings: {} })
      if (table === 'league_members') return Response.json([{ id: 'home' }, { id: 'away' }])
      if (table === 'finalize_score_week_atomic') {
        matchup.is_finalized = true
        matchup.winner_member_id = 'home'
        matchup.finalized_at = '2026-04-13T23:10:00Z'
        return Response.json([])
      }
      if (table === 'apply_season_boundary_after_grace') {
        assert.equal(matchup.is_finalized, true)
        assert.equal(JSON.parse(String(init?.body)).p_action, 'advance')
        return Response.json({ applied: true })
      }
      return Response.json([])
    }
    try {
      assert.deepEqual(await runSeasonBoundary(new Date('2026-04-12T13:00:00Z')),
        [{ leagueId: 'league', actions: [] }])
      calls.length = 0
      assert.deepEqual(await runSeasonBoundary(new Date('2026-04-14T13:00:00Z')),
        [{ leagueId: 'league', actions: ['final-created'] }])
      if (!finalized) assert.ok(calls.indexOf('finalize_score_week_atomic') < calls.indexOf('apply_season_boundary_after_grace'))
    } finally { globalThis.fetch = nativeFetch }
  })
}

Deno.test('a round with no games in its final week uses its earlier last game', async () => {
  const nativeFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const table = url.pathname.split('/').at(-1)
    if (table === 'league_seasons') return Response.json(url.searchParams.get('select') === 'season_year'
      ? { season_year: 2026 } : [{ id: 'season', league_id: 'league', leagues: { status: 'playoffs', playoff_start_week: 1 } }])
    if (table === 'matchups') return Response.json([{ matchup_type: 'playoff_semifinal', playoff_round: 1,
      week_number: 1, end_week_number: 2, is_finalized: true, finalized_at: '2026-04-21T00:10:00Z', winner_member_id: 'home' }])
    if (table === 'season_weeks') return Response.json(url.searchParams.get('week_number') === 'eq.1'
      ? { week_start: '2026-04-06', week_end: '2026-04-12' }
      : { week_start: '2026-04-13', week_end: '2026-04-19' })
    if (table === 'nba_games') return Response.json(url.searchParams.get('game_date') === 'gte.2026-04-06'
      ? [{ nba_game_id: '002round', game_date: '2026-04-12', status: 'Final', game_status_text: null }] : [])
    if (table === 'get_stale_score_weeks') return Response.json([])
    if (table === 'apply_season_boundary_after_grace') return Response.json({ applied: true })
    throw new Error(`Unexpected request ${url}`)
  }
  try {
    assert.deepEqual(await runSeasonBoundary(new Date('2026-04-21T00:20:00Z')),
      [{ leagueId: 'league', actions: ['final-created'] }])
  } finally { globalThis.fetch = nativeFetch }
})

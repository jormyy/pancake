import { strict as assert } from 'node:assert'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'boundary-date-test')
const { runSeasonBoundary } = await import('./seasonBoundary.ts')

Deno.test('generation waits for two ET dates after the last available regular game and ignores recent finalization', async () => {
  const nativeFetch = globalThis.fetch
  let finalizedAt = '2026-02-07T00:00:00Z'
  let games = true
  let calls = 0
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const table = url.pathname.split('/').at(-1)
    if (table === 'league_seasons') return Response.json(url.searchParams.get('select') === 'season_year'
      ? { season_year: 2026 } : [{ id: 'season', league_id: 'league', leagues: { status: 'active', playoff_start_week: 2 } }])
    if (table === 'matchups') return Response.json([{ matchup_type: 'regular_season', week_number: 1,
      is_finalized: true, finalized_at: finalizedAt, winner_member_id: 'winner' }])
    if (table === 'season_weeks') return Response.json({ week_start: '2026-02-01', week_end: '2026-02-07' })
    if (table === 'nba_games') return Response.json(games ? [
      { nba_game_id: '002fixture', game_date: '2026-02-06', status: 'Final', game_status_text: null },
      { nba_game_id: '001fixture', game_date: '2026-02-07', status: 'Final', game_status_text: null },
      { nba_game_id: '002cancelled', game_date: '2026-02-07', status: 'Final', game_status_text: 'Cancelled' },
    ] : [])
    if (table === 'get_stale_score_weeks') return Response.json([])
    if (table === 'apply_season_boundary_after_grace') { calls++; return Response.json({ applied: true }) }
    throw new Error(`Unexpected request ${url}`)
  }
  try {
    assert.deepEqual(await runSeasonBoundary(new Date('2026-02-08T04:59:59Z')), [{ leagueId: 'league', actions: [] }])
    assert.equal(calls, 0)
    finalizedAt = '2026-02-08T04:59:00Z'
    assert.deepEqual(await runSeasonBoundary(new Date('2026-02-08T05:00:00Z')), [{ leagueId: 'league', actions: ['bracket-generated'] }])
    assert.equal(calls, 1)
    games = false
    assert.deepEqual(await runSeasonBoundary(new Date('2026-02-08T05:00:00Z')), [{ leagueId: 'league', actions: [] }])
    assert.equal(calls, 1)
    assert.deepEqual(await runSeasonBoundary(new Date('2026-02-09T05:00:00Z')), [{ leagueId: 'league', actions: ['bracket-generated'] }])
    assert.equal(calls, 2)
  } finally { globalThis.fetch = nativeFetch }
})

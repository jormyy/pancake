import { strict as assert } from 'node:assert'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'pending-score-test')
const { syncScores } = await import('./syncScores.ts')

for (const pending of [true, false]) {
  Deno.test(`finalization ${pending ? 'skips capture for pending games' : 'captures inputs before reading certified scores'}`, async () => {
    const nativeFetch = globalThis.fetch
    const calls: string[] = []
    const week = { week_number: 1, week_start: '2026-02-01', week_end: '2026-02-07' }
    globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input)
      const table = url.pathname.split('/').at(-1)!
      const select = url.searchParams.get('select') ?? ''
      calls.push(`${table}:${select}`)
      if (table === 'league_seasons') return Response.json([{ id: 'season', league_id: 'league', season_year: 2026,
        is_current: false, leagues: { scoring_settings: {} } }])
      if (table === 'season_weeks') return Response.json(url.searchParams.get('week_number')?.startsWith('eq.') ? week : [week])
      if (table === 'get_stale_score_weeks') return Response.json([{ week_number: 1 }])
      if (table === 'capture_score_inputs') return Response.json({ token: 1 })
      if (table === 'leagues') return Response.json({ scoring_settings: {} })
      if (table === 'matchups' && select === 'end_week_number') return Response.json([{ end_week_number: null }])
      if (table === 'matchups' && select.startsWith('id,end_week_number')) return Response.json([{ id: 'matchup',
        end_week_number: null, home_member_id: 'home', away_member_id: 'away', home_points: 0, away_points: 0,
        is_finalized: true, matchup_type: 'regular_season', winner_member_id: null }])
      if (table === 'get_score_sync_games') return Response.json(pending ? [{ id: 'game', nba_game_id: '002fixture' }] : [])
      return Response.json([])
    }
    try {
      await syncScores('league', new Date('2026-02-10T14:00:00Z'), { recoverStats: false })
      const finalization = calls.slice(calls.findIndex(call => call === 'matchups:end_week_number'))
      const capture = finalization.findIndex(call => call.startsWith('capture_score_inputs:'))
      const pendingRead = finalization.findIndex(call => call.startsWith('get_score_sync_games:'))
      assert.ok(pendingRead >= 0, 'finalization checks pending games')
      if (pending) {
        assert.equal(capture, -1, 'pending games must not acquire score input revisions')
        assert.equal(calls.some(call => call.startsWith('leagues:')), false)
        assert.equal(calls.some(call => call.startsWith('matchups:id,end_week_number')), false)
      } else {
        assert.ok(capture > pendingRead, 'cheap pending check precedes capture')
        assert.ok(finalization.findIndex(call => call.startsWith('leagues:')) > capture)
        assert.ok(finalization.findIndex(call => call.startsWith('matchups:id,end_week_number')) > capture)
      }
    } finally { globalThis.fetch = nativeFetch }
  })
}

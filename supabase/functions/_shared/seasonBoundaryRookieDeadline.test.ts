import { strict as assert } from 'node:assert'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'rookie-deadline-test')
const { runSeasonBoundary } = await import('./seasonBoundary.ts')

Deno.test('opening night completes a paused rookie draft before activating its league', async () => {
  const nativeFetch = globalThis.fetch
  let completed = false
  const calls: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const table = url.pathname.split('/').at(-1)!
    if (table === 'league_seasons') return Response.json(url.searchParams.get('select')?.startsWith('season_year')
      ? { season_year: 2026, skipped_weeks: [] }
      : [{ id: 'season', league_id: 'league', leagues: { status: 'drafting', playoff_start_week: 20 } }])
    if (table === 'season_weeks') return Response.json([{ week_number: 1, week_start: '2026-10-20' }])
    if (table === 'draft_timer_start_warning') return Response.json({ openingNightCutoff: '2026-10-20T13:00:00Z' })
    if (table === 'drafts') {
      if (url.searchParams.get('id')) return Response.json({ status: completed ? 'completed' : 'paused' })
      if (url.searchParams.get('status') === 'in.(completed,cancelled)') return Response.json(completed ? [{ id: 'draft' }] : [])
      return Response.json([{ id: 'draft', status: completed ? 'completed' : 'paused' }])
    }
    if (table === 'process_expired_snake_picks_atomic') {
      calls.push(table)
      completed = true
      return Response.json([])
    }
    if (table === 'activate_rookie_draft_league_atomic') {
      calls.push(table)
      assert.deepEqual(JSON.parse(String(init && 'body' in init ? init.body : undefined)), { p_draft_id: 'draft' })
      assert.equal(completed, true)
      return Response.json(true)
    }
    throw new Error(`Unexpected request ${url}`)
  }
  try {
    assert.deepEqual(await runSeasonBoundary(new Date('2026-10-20T13:00:00Z')),
      [{ leagueId: 'league', actions: ['rookie-draft-auto-completed', 'rookie-league-activated'] }])
    assert.deepEqual(calls, ['process_expired_snake_picks_atomic', 'activate_rookie_draft_league_atomic'])
  } finally { globalThis.fetch = nativeFetch }
})

Deno.test('opening night activates a stopped rookie draft without making its remaining picks', async () => {
  const nativeFetch = globalThis.fetch
  let activated = false
  globalThis.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : input)
    const table = url.pathname.split('/').at(-1)!
    if (table === 'league_seasons') return Response.json(url.searchParams.get('select')?.startsWith('season_year')
      ? { season_year: 2026, skipped_weeks: [] }
      : [{ id: 'season', league_id: 'league', leagues: { status: 'drafting', playoff_start_week: 20 } }])
    if (table === 'season_weeks') return Response.json([{ week_number: 1, week_start: '2026-10-20' }])
    if (table === 'draft_timer_start_warning') return Response.json({ openingNightCutoff: '2026-10-20T13:00:00Z' })
    if (table === 'drafts') {
      const status = url.searchParams.get('status')
      if (status === 'neq.cancelled') return Response.json([])
      return Response.json(status?.includes('cancelled') ? [{ id: 'draft', status: 'cancelled' }] : [])
    }
    if (table === 'activate_rookie_draft_league_atomic') { activated = true; return Response.json(true) }
    throw new Error(`Unexpected request ${url}`)
  }
  try {
    assert.deepEqual(await runSeasonBoundary(new Date('2026-10-20T13:00:00Z')),
      [{ leagueId: 'league', actions: ['rookie-league-activated'] }])
    assert.equal(activated, true)
  } finally { globalThis.fetch = nativeFetch }
})

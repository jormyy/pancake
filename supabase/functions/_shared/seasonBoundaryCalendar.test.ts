import { deepStrictEqual } from 'node:assert/strict'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:56221')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'synthetic-unit-test')
const { runSeasonBoundary } = await import('./seasonBoundary.ts')

Deno.test('rollover waits for an unpublished next-season calendar without reporting a failed transition', async () => {
  const nativeFetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname.endsWith('/league_seasons')) {
      if (url.searchParams.get('select') === 'season_year') return Promise.resolve(Response.json({ season_year: 2027 }))
      return Promise.resolve(Response.json([{ id: 'old-season', league_id: 'league', leagues: { status: 'playoffs', playoff_start_week: 23 } }]))
    }
    if (url.pathname.endsWith('/matchups')) {
      if (init?.method === 'HEAD') return Promise.resolve(new Response(null, { headers: { 'content-range': '*/0' } }))
      return Promise.resolve(Response.json([{ id: 'final', matchup_type: 'playoff_final', playoff_round: 2, week_number: 24, is_finalized: true, finalized_at: '2026-04-13T09:00:00Z', winner_member_id: 'winner' }]))
    }
    if (url.pathname.endsWith('/get_stale_score_weeks')) return Promise.resolve(Response.json([]))
    if (url.pathname.endsWith('/apply_season_boundary_after_grace')) return Promise.resolve(Response.json({ applied: true, new_season_id: 'new-season' }))
    if (url.pathname.endsWith('/draft_timer_start_warning')) return Promise.resolve(Response.json({ openingNightCutoff: null }))
    if (url.pathname.endsWith('/league_members')) return Promise.resolve(Response.json([{ id: 'a' }, { id: 'b' }]))
    if (url.pathname.endsWith('/season_weeks')) return Promise.resolve(Response.json([]))
    if (url.pathname.endsWith('/replace_regular_season_matchups_atomic')) return Promise.resolve(Response.json({ code: '22023', message: 'The season 2027 calendar is unavailable. Load the calendar before changing or generating the schedule.' }, { status: 400 }))
    throw new Error(`Unexpected request: ${url.pathname}`)
  }
  try {
    const result = await runSeasonBoundary(new Date('2026-04-15T14:00:00Z'))
    deepStrictEqual(result, [{ leagueId: 'league', actions: ['season-advanced', 'calendar-pending'] }])
  } finally { globalThis.fetch = nativeFetch }
})

Deno.test('offseason retries generation after publication and retains errors for an invalid published calendar', async () => {
  const nativeFetch = globalThis.fetch
  let invalid = false
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname.endsWith('/league_seasons')) return Promise.resolve(Response.json(url.searchParams.get('select')?.startsWith('season_year') ? { season_year: 2027, skipped_weeks: [] } : [{ id: 'new-season', league_id: 'league', leagues: { status: 'offseason', playoff_start_week: 23 } }]))
    if (url.pathname.endsWith('/matchups') && init?.method === 'HEAD') return Promise.resolve(new Response(null, { headers: { 'content-range': '*/0' } }))
    if (url.pathname.endsWith('/season_weeks')) return Promise.resolve(Response.json([{ week_number: 1, week_start: '2026-10-20' }]))
    if (url.pathname.endsWith('/draft_timer_start_warning')) return Promise.resolve(Response.json({ openingNightCutoff: null }))
    if (url.pathname.endsWith('/league_members')) return Promise.resolve(Response.json([{ id: 'a' }, { id: 'b' }]))
    if (url.pathname.endsWith('/replace_regular_season_matchups_atomic')) return Promise.resolve(invalid ? Response.json({ code: '22023', message: 'Published calendar has a missing week' }, { status: 400 }) : Response.json({ inserted: 22 }))
    throw new Error(`Unexpected request: ${url.pathname}`)
  }
  try {
    deepStrictEqual(await runSeasonBoundary(new Date('2026-04-15T14:00:00Z')), [{ leagueId: 'league', actions: ['matchups-generated'] }])
    invalid = true
    deepStrictEqual(await runSeasonBoundary(new Date('2026-04-15T14:00:00Z')), [{ leagueId: 'league', actions: [], error: 'Published calendar has a missing week' }])
  } finally { globalThis.fetch = nativeFetch }
})

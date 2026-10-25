import { strict as assert } from 'node:assert'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'draft-notification-test')
const { closeExpiredNominations } = await import('../close-expired-nominations/close.ts')
const { runSeasonBoundary } = await import('./seasonBoundary.ts')

Deno.test('the timer leaves durable auto-pick notifications to the database', async () => {
  const nativeFetch = globalThis.fetch
  const queued: Record<string, unknown>[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const table = url.pathname.split('/').at(-1)
    if (table === 'close_expired_auction_nominations_atomic') return Response.json([])
    if (table === 'process_expired_snake_picks_atomic') return Response.json([
      { draft_id: 'real', pick_id: 'picked', member_id: 'owner', player_id: 'rookie', picked: true },
      { draft_id: 'mock', pick_id: 'mock-pick', member_id: 'mock-owner', player_id: 'mock-player', picked: true },
      { draft_id: 'real', pick_id: 'skipped', member_id: 'skipped-owner', player_id: null, picked: false },
      { draft_id: 'real', pick_id: 'error', member_id: 'error-owner', player_id: null, picked: false, error_code: 'P0001', error_message: 'Pick failed' },
    ])
    if (table === 'drafts') {
      assert.equal(url.searchParams.get('is_mock'), 'eq.false')
      assert.equal(url.searchParams.get('draft_type'), 'eq.snake')
      return Response.json([{ id: 'real' }])
    }
    assert.equal(table, 'notification_outbox')
    assert.equal(url.searchParams.get('on_conflict'), 'dedupe_key')
    assert.ok(new Headers(init?.headers).get('prefer')?.includes('resolution=ignore-duplicates'))
    queued.push(JSON.parse(String(init?.body)))
    return new Response(null, { status: 201 })
  }
  try {
    const result = await closeExpiredNominations()
    assert.equal(result.autoPicked, 2)
    assert.equal(result.failed, 1)
    assert.deepEqual(queued, [])
  } finally { globalThis.fetch = nativeFetch }
})

Deno.test('the season backstop leaves durable auto-pick notifications to the database', async () => {
  const nativeFetch = globalThis.fetch
  const queued: Record<string, unknown>[] = []
  let picked = false
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const table = url.pathname.split('/').at(-1)
    if (table === 'league_seasons') return Response.json(url.searchParams.get('select')?.startsWith('season_year')
      ? { season_year: 2027, skipped_weeks: [] } : [{ id: 'season', league_id: 'league', leagues: { status: 'offseason', playoff_start_week: 1 } }])
    if (table === 'matchups') return new Response(null, { headers: { 'content-range': '*/0' } })
    if (table === 'season_weeks') return Response.json([{ week_number: 1, week_start: '2026-10-20' }])
    if (table === 'draft_timer_start_warning') return Response.json({ openingNightCutoff: null })
    if (table === 'drafts') return Response.json([{ id: 'draft', status: 'in_progress' }])
    if (table === 'snake_draft_picks') return init?.method === 'HEAD'
      ? new Response(null, { headers: { 'content-range': '*/0' } })
      : Response.json(picked ? null : { id: 'pick', member_id: 'owner' })
    if (table === 'auto_pick_snake_pick_atomic') { picked = true; return Response.json({ player_id: 'rookie' }) }
    assert.equal(table, 'notification_outbox')
    queued.push(JSON.parse(String(init?.body)))
    return new Response(null, { status: 201 })
  }
  try {
    assert.deepEqual(await runSeasonBoundary(new Date('2026-10-24T14:00:00Z')),
      [{ leagueId: 'league', actions: ['rookie-draft-auto-completed'] }])
    assert.deepEqual(queued, [])
  } finally { globalThis.fetch = nativeFetch }
})

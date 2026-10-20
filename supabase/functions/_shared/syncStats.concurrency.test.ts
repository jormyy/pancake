import { deepStrictEqual, equal, ok } from 'node:assert/strict'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:56221')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'synthetic-unit-test')
Deno.env.set('NBA_CDN_BASE_URL', 'http://127.0.0.1:56280/static/json')
const { syncLiveStatsGames } = await import('./syncStats.ts')

Deno.test('live games fetch concurrently without competing for the season write lock', async () => {
  const nativeFetch = globalThis.fetch
  let locked = false, fetched = 0, firstWriteFetched = 0, writes = 0
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    equal(url.hostname, '127.0.0.1')
    if (url.port === '56280') {
      fetched++
      await new Promise(resolve => setTimeout(resolve, 1))
      return Response.json({ game: { gameStatus: 2, period: 1, gameClock: 'PT11M00.00S', homeTeam: { players: [{ personId: 1, name: 'Synthetic player', played: '1', statistics: { minutes: 'PT1M00.00S', points: 2 } }] }, awayTeam: { players: [] } } })
    }
    equal(url.port, '56221')
    if (url.pathname.endsWith('/assert_nba_game_unambiguous')) return Response.json(null)
    if (url.pathname.endsWith('/resolve_player_imports_atomic')) return Response.json({ results: [{ index: 0, player_id: 'synthetic-player', action: 'updated' }], stale_draft_numbers_cleared: 0 })
    equal(url.pathname, '/rest/v1/rpc/save_live_game_stats_atomic')
    ok(JSON.parse(String(init?.body)).p_game_id)
    if (locked) return Response.json({ code: 'PT409', message: 'Game inputs are being updated. Retry this operation.' }, { status: 409 })
    locked = true
    if (!writes) firstWriteFetched = fetched
    await new Promise(resolve => setTimeout(resolve, 10))
    writes++
    locked = false
    return Response.json(1)
  }
  try {
    const result = await syncLiveStatsGames(Array.from({ length: 4 }, (_, index) => ({ id: `synthetic-${index}`, nba_game_id: `00225${String(index).padStart(5, '0')}`, season_year: 2026, week_number: 1, status: 'InProgress' })))
    deepStrictEqual(result.failures, [])
    equal(result.statLines, 4)
    equal(writes, 4)
    ok(firstWriteFetched > 1, 'Provider reads remain parallel')
  } finally { globalThis.fetch = nativeFetch }
})

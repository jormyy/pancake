import { deepStrictEqual, equal } from 'node:assert/strict'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:56221')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'synthetic-unit-test')
Deno.env.set('NBA_CDN_BASE_URL', 'http://127.0.0.1:56280/static/json')
const { syncLiveStatsGames } = await import('./syncStats.ts')
const contention = { code: 'PT409', message: 'Game inputs are being updated. Retry this operation.' }
const statistics = Object.fromEntries(['assists', 'blocks', 'fieldGoalsAttempted', 'fieldGoalsMade', 'foulsPersonal', 'freeThrowsAttempted', 'freeThrowsMade', 'plusMinusPoints', 'points', 'reboundsDefensive', 'reboundsOffensive', 'reboundsTotal', 'steals', 'threePointersAttempted', 'threePointersMade', 'turnovers'].map(key => [key, 0]))

async function exercise(isFinal: boolean, fail: (path: string, count: number) => object | null) {
  const nativeFetch = globalThis.fetch
  const calls: Record<string, number> = {}
  globalThis.fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : input)
    equal(url.hostname, '127.0.0.1')
    calls[url.pathname] = (calls[url.pathname] ?? 0) + 1
    const error = fail(url.pathname, calls[url.pathname])
    if (error) return Promise.resolve(Response.json(error, { status: 409 }))
    if (url.port === '56280') {
      const player = (personId: number) => ({ personId, name: `Synthetic ${personId}`, played: '1', statistics: { ...statistics, minutes: 'PT1M00.00S' } })
      return Promise.resolve(Response.json({ game: { gameStatus: isFinal ? 3 : 2, period: 1, gameClock: 'PT11M00.00S', homeTeam: { players: [player(1)] }, awayTeam: { players: [player(2)] } } }))
    }
    equal(url.port, '56221')
    if (url.pathname.endsWith('/assert_nba_game_unambiguous')) return Promise.resolve(Response.json(null))
    if (url.pathname.endsWith('/resolve_player_imports_atomic')) return Promise.resolve(Response.json({ results: [0, 1].map(index => ({ index, player_id: `player-${index}`, action: 'updated' })), stale_draft_numbers_cleared: 0 }))
    equal(url.pathname, `/rest/v1/rpc/${isFinal ? 'save_game_stats_atomic' : 'save_live_game_stats_atomic'}`)
    return Promise.resolve(Response.json(2))
  }
  try {
    const result = await syncLiveStatsGames([{ id: 'game', nba_game_id: '0022500170', season_year: 2026, week_number: 3, status: isFinal ? 'Final' : 'InProgress' }])
    return { result, calls }
  } finally { globalThis.fetch = nativeFetch }
}

Deno.test('source-lock contention retries identity validation and atomic persistence without refetching the provider', async () => {
  for (const isFinal of [true, false]) {
    const { result, calls } = await exercise(isFinal, (path, count) => count === 1 && (path.endsWith('/assert_nba_game_unambiguous') || path.includes('/save_')) ? contention : null)
    deepStrictEqual(result.failures, [])
    equal(result.statLines, 2)
    equal(calls['/static/json/liveData/boxscore/boxscore_0022500170.json'], 1)
    equal(calls['/rest/v1/rpc/assert_nba_game_unambiguous'], 3)
    equal(calls[`/rest/v1/rpc/${isFinal ? 'save_game_stats_atomic' : 'save_live_game_stats_atomic'}`], 2)
  }
})

Deno.test('persistent contention stays visible after bounded retries', async () => {
  const { result, calls } = await exercise(true, path => path.endsWith('/assert_nba_game_unambiguous') ? contention : null)
  equal(result.failures.length, 1)
  equal(calls['/rest/v1/rpc/assert_nba_game_unambiguous'], 5)
  equal(result.statLines, 0)
})

Deno.test('identity changes and incomplete data are not retried as lock contention', async () => {
  for (const error of [{ code: 'PT409', message: 'Game provider identity changed. Fetch the game again.' }, { code: '22023', message: 'The complete box score omits stored players.' }]) {
    const { result, calls } = await exercise(true, path => path.includes('/save_') ? error : null)
    equal(result.failures.length, 1)
    equal(calls['/rest/v1/rpc/save_game_stats_atomic'], 1)
  }
})

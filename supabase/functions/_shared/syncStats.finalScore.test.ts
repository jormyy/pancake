import { deepStrictEqual, equal } from 'node:assert/strict'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:56221')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'synthetic-unit-test')
Deno.env.set('NBA_CDN_BASE_URL', 'http://127.0.0.1:56280/static/json')
const { syncLiveStatsGames } = await import('./syncStats.ts')
const statistics = Object.fromEntries(['assists', 'blocks', 'fieldGoalsAttempted', 'fieldGoalsMade', 'foulsPersonal', 'freeThrowsAttempted', 'freeThrowsMade', 'plusMinusPoints', 'points', 'reboundsDefensive', 'reboundsOffensive', 'reboundsTotal', 'steals', 'threePointersAttempted', 'threePointersMade', 'turnovers'].map(key => [key, 0]))
const player = (personId: number) => ({ personId, name: `Synthetic ${personId}`, played: '1', statistics: { ...statistics, minutes: 'PT1M00.00S' } })
type Box = { sourceTime?: string; gameStatus: number; gameStatusText?: string; homeScore?: unknown; awayScore?: unknown; homePlayers?: unknown[] }

type Stored = { status: string; home_score?: number; away_score?: number; game_status_text?: string | null }

async function exercise(box: Box, fail: (path: string, count: number) => object | null = () => null, stored: Stored = { status: 'InProgress' }) {
  const nativeFetch = globalThis.fetch
  const calls: { path: string; body: unknown }[] = []
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    equal(url.hostname, '127.0.0.1')
    const body = request.method === 'POST' ? await request.json() : null
    calls.push({ path: url.pathname, body })
    const error = fail(url.pathname, calls.filter(call => call.path === url.pathname).length)
    if (error) return Response.json(error, { status: 409 })
    if (url.port === '56280') {
      return Response.json({ meta: { time: box.sourceTime }, game: { gameStatus: box.gameStatus, gameStatusText: box.gameStatusText, period: 4, gameClock: 'PT00M00.00S',
        homeTeam: { score: box.homeScore, players: box.homePlayers ?? [player(1)] }, awayTeam: { score: box.awayScore, players: [player(2)] } } })
    }
    equal(url.port, '56221')
    if (url.pathname.endsWith('/assert_nba_game_unambiguous')) return Response.json(null)
    if (url.pathname.endsWith('/resolve_player_imports_atomic')) return Response.json({ results: [0, 1].map(index => ({ index, player_id: `player-${index}`, action: 'updated' })), stale_draft_numbers_cleared: 0 })
    if (url.pathname.endsWith('/save_live_scoreboard_atomic')) return Response.json(true)
    equal(url.pathname, `/rest/v1/rpc/${box.sourceTime && box.gameStatus === 3 ? 'save_final_game_snapshot_atomic' : box.gameStatus === 3 ? 'save_game_stats_atomic' : 'save_live_game_stats_atomic'}`)
    return Response.json(2)
  }
  try {
    const result = await syncLiveStatsGames([{ id: 'game', nba_game_id: '0022400062', season_year: 2025, week_number: 1, ...stored }])
    return { result, rpc: calls.filter(call => call.path.startsWith('/rest/v1/rpc/')).map(call => ({ name: call.path.slice(13), body: call.body })) }
  } finally { globalThis.fetch = nativeFetch }
}
const names = (rpc: { name: string }[]) => rpc.map(call => call.name)
const finalScore = (home: number, away: number, text: string) => ({ name: 'save_live_scoreboard_atomic', body: {
  p_game_id: 'game', p_provider_game_id: '0022400062', p_status: 'Final', p_home_score: home, p_away_score: away,
  p_status_text: text, p_elapsed_seconds: 0,
} })

Deno.test('a final box saves its team scores and status text before the final stats', async () => {
  const { result, rpc } = await exercise({ gameStatus: 3, gameStatusText: 'Final', homeScore: 110, awayScore: 103 })
  deepStrictEqual(result.failures, [])
  equal(result.statLines, 2)
  deepStrictEqual(names(rpc), ['assert_nba_game_unambiguous', 'resolve_player_imports_atomic', 'save_live_scoreboard_atomic', 'save_game_stats_atomic'])
  deepStrictEqual(rpc[2], finalScore(110, 103, 'Final'))
})

Deno.test('a final box without status text is stored as Final', async () => {
  for (const gameStatusText of [undefined, '', '  ']) {
    const { rpc } = await exercise({ gameStatus: 3, gameStatusText, homeScore: 113, awayScore: 116 })
    deepStrictEqual(rpc[2], finalScore(113, 116, 'Final'))
  }
})

Deno.test('live boxes and final boxes without valid team scores leave the scoreboard score alone', async () => {
  const cases: Box[] = [
    { gameStatus: 2, gameStatusText: 'Q4 0:01', homeScore: 100, awayScore: 101 },
    { gameStatus: 3, gameStatusText: 'Final' },
    { gameStatus: 3, gameStatusText: 'Final', homeScore: 110 },
    { gameStatus: 3, gameStatusText: 'Final', homeScore: '110', awayScore: 103 },
    { gameStatus: 3, gameStatusText: 'Final', homeScore: 110.5, awayScore: 103 },
    { gameStatus: 3, gameStatusText: 'Final', homeScore: -1, awayScore: 103 },
  ]
  for (const box of cases) {
    const { result, rpc } = await exercise(box)
    deepStrictEqual(result.failures, [])
    equal(names(rpc).includes('save_live_scoreboard_atomic'), false)
  }
})

Deno.test('a final recheck repairs a frozen mid-game score and skips a settled one', async () => {
  const box = { gameStatus: 3, gameStatusText: 'Final', homeScore: 110, awayScore: 103 }
  const frozen = await exercise(box, undefined, { status: 'Final', home_score: 85, away_score: 76, game_status_text: 'Q4 11:34' })
  deepStrictEqual(frozen.rpc[2], finalScore(110, 103, 'Final'))
  const staleText = await exercise(box, undefined, { status: 'Final', home_score: 110, away_score: 103, game_status_text: 'Q4 0:00' })
  deepStrictEqual(staleText.rpc[2], finalScore(110, 103, 'Final'))
  for (const game_status_text of ['Final', 'Final/OT']) {
    const settled = await exercise(box, undefined, { status: 'Final', home_score: 110, away_score: 103, game_status_text })
    deepStrictEqual(settled.result.failures, [])
    deepStrictEqual(names(settled.rpc), ['assert_nba_game_unambiguous', 'resolve_player_imports_atomic', 'save_game_stats_atomic'])
  }
})

Deno.test('an incomplete final box saves no score', async () => {
  const { result, rpc } = await exercise({ gameStatus: 3, gameStatusText: 'Final', homeScore: 110, awayScore: 103, homePlayers: [] })
  equal(result.failures.length, 1)
  deepStrictEqual(names(rpc), ['assert_nba_game_unambiguous'])
})

Deno.test('source-lock contention on the final score retries the whole write', async () => {
  const contention = { code: 'PT409', message: 'Game inputs are being updated. Retry this operation.' }
  const { result, rpc } = await exercise({ gameStatus: 3, gameStatusText: 'Final', homeScore: 110, awayScore: 103 },
    (path, count) => path.endsWith('/save_live_scoreboard_atomic') && count === 1 ? contention : null)
  deepStrictEqual(result.failures, [])
  deepStrictEqual(names(rpc), ['assert_nba_game_unambiguous', 'resolve_player_imports_atomic', 'save_live_scoreboard_atomic',
    'assert_nba_game_unambiguous', 'resolve_player_imports_atomic', 'save_live_scoreboard_atomic', 'save_game_stats_atomic'])
})

Deno.test('a failed final score write leaves the stats unsynced for the next tick', async () => {
  const { result, rpc } = await exercise({ gameStatus: 3, gameStatusText: 'Final', homeScore: 110, awayScore: 103 },
    path => path.endsWith('/save_live_scoreboard_atomic') ? { code: 'PT409', message: 'Game inputs changed. Retry.' } : null)
  equal(result.failures.length, 1)
  equal(names(rpc).includes('save_game_stats_atomic'), false)
})

Deno.test('published final revisions keep scores and stats in one versioned write', async () => {
  const { result, rpc } = await exercise({ sourceTime: '2026-10-22 00:33:23.904611', gameStatus: 3, homeScore: 103, awayScore: 110 })
  deepStrictEqual(result.failures, [])
  deepStrictEqual(names(rpc), ['assert_nba_game_unambiguous', 'resolve_player_imports_atomic', 'save_final_game_snapshot_atomic'])
  const payload = rpc[2].body as Record<string, unknown>
  equal(payload.p_source_updated_at, '2026-10-22T00:33:23.904611Z')
  equal(payload.p_home_score, 103)
  equal(payload.p_away_score, 110)
})

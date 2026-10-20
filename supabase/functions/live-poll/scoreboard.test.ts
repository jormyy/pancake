import { deepStrictEqual, equal } from 'node:assert/strict'
import type { NBAGame } from '../_shared/nba.ts'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:56221')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'synthetic-unit-test')
const { saveScoreboardGames } = await import('./scoreboard.ts')

Deno.test('a healthy scoreboard discovers a live game during its scheduled polling backoff', async () => {
  const nativeFetch = globalThis.fetch
  const writes: string[] = []
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    equal(url.origin, 'http://127.0.0.1:56221')
    if (url.pathname === '/rest/v1/nba_games') return Promise.resolve(Response.json([{ id: 'late-id', nba_game_id: '0022500087', status: 'Scheduled', home_score: 0, away_score: 0, game_status_text: 'Scheduled' }]))
    equal(url.pathname, '/rest/v1/rpc/save_live_scoreboard_atomic')
    writes.push(JSON.parse(String(init?.body)).p_game_id)
    return Promise.resolve(Response.json(null))
  }
  try {
    const games: NBAGame[] = ['0022500080', '0022500087'].map(gameId => ({ gameId, gameStatus: 2, gameStatusText: 'Q1', period: 1, gameClock: 'PT06M00.00S', homeTeam: { teamTricode: 'UTA', score: 14 }, awayTeam: { teamTricode: 'LAC', score: 12 } }))
    await saveScoreboardGames(games, [{ id: 'active-id', nba_game_id: '0022500080', status: 'InProgress', home_score: 10, away_score: 9, game_status_text: 'Q1' }])
    deepStrictEqual(writes, ['active-id', 'late-id'])
  } finally { globalThis.fetch = nativeFetch }
})

import { deepStrictEqual, equal } from 'node:assert/strict'
import type { NBABoxScorePlayer } from './nba.ts'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:61021')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'inactive-row-test')
const { resolveBoxScorePlayers } = await import('./syncStats.ts')
const statistics = Object.fromEntries(['assists', 'blocks', 'fieldGoalsAttempted', 'fieldGoalsMade', 'foulsPersonal',
  'freeThrowsAttempted', 'freeThrowsMade', 'plusMinusPoints', 'points', 'reboundsDefensive', 'reboundsOffensive',
  'reboundsTotal', 'steals', 'threePointersAttempted', 'threePointersMade', 'turnovers'].map(key => [key, 0]))

for (const gameStatus of [2, 3]) {
  Deno.test(gameStatus === 2 ? 'live boxes omit explicitly inactive players' : 'final boxes retain every supplied player', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      equal(new URL(request.url).origin, 'http://127.0.0.1:61021')
      equal(new URL(request.url).pathname, '/rest/v1/rpc/resolve_player_imports_atomic')
      const body = await request.json()
      return Response.json({ results: body.p_records.map((record: { provider_id: string }, index: number) =>
        ({ index, player_id: record.provider_id, action: 'updated' })), stale_draft_numbers_cleared: 0 })
    }
    try {
      const player = (personId: number, status?: string) => ({ personId, name: `Player ${personId}`, status,
        played: '0', statistics: { ...statistics, minutes: 'PT00M00.00S' } }) as unknown as NBABoxScorePlayer
      const result = await resolveBoxScorePlayers({ gameStatus,
        homeTeam: { players: [player(1, 'INACTIVE'), player(2, 'ACTIVE')] },
        awayTeam: { players: [player(3), player(4, 'INACTIVE')] },
      }, '0022600142')
      deepStrictEqual(result.map(row => [row.playerId, row.player.isHome]), gameStatus === 2
        ? [['2', true], ['3', false]] : [['1', true], ['2', true], ['3', false], ['4', false]])
    } finally { globalThis.fetch = originalFetch }
  })
}

import { strict as assert } from 'node:assert'
import type { NBABoxScorePlayer } from './nba.ts'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'local-cdn-batch-test')
const { resolveBoxScorePlayers, recordBoxSides } = await import('./syncStats.ts')

Deno.test('each CDN box score resolves all identities in one request without scanning players', async () => {
  const nativeFetch = globalThis.fetch
  const requests: { path: string; records: unknown[] }[] = []
  let generation = 0
  let conflict = false
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const path = new URL(request.url).pathname
    if (path === '/rest/v1/players') {
      requests.push({ path, records: [] })
      return Response.json([])
    }
    assert.equal(path, '/rest/v1/rpc/resolve_player_imports_atomic')
    const body = await request.json()
    assert.equal(body.p_source, 'nba_cdn')
    requests.push({ path, records: body.p_records })
    if (conflict) return Response.json({ message: 'Conflicting provider identity', code: '22023' }, { status: 400 })
    return Response.json({
      results: body.p_records.map((record: { provider_id: string }, index: number) => ({
        index, player_id: `${generation}-${record.provider_id}`, action: 'updated',
      })),
      stale_draft_numbers_cleared: 0,
    })
  }
  try {
    const players = Array.from({ length: 24 }, (_, index) => ({
      personId: index + 1, name: `Fixture Player ${index}`, statistics: { points: index },
    })) as NBABoxScorePlayer[]
    const feed = { gameStatus: 2, homeTeam: { players: players.slice(0, 12) }, awayTeam: { players: players.slice(12) } }
    const first = await resolveBoxScorePlayers(feed, 'fixture')
    assert.deepEqual(first.map(row => row.playerId), players.map(player => `0-${player.personId}`))
    assert.equal(requests.filter(request => request.path === '/rest/v1/players').length, 0, 'CDN resolution must not scan the player table')
    assert.deepEqual(requests.map(request => request.records.length), [24], 'All identities in one feed must share one atomic request')
    requests.length = 0
    generation = 1
    const merged = await resolveBoxScorePlayers(feed, 'fixture')
    assert.deepEqual(merged.map(row => row.playerId), players.map(player => `1-${player.personId}`))
    assert.deepEqual(requests.map(request => request.records.length), [24], 'An unchanged feed must still verify current canonical identities')
    conflict = true
    await assert.rejects(() => resolveBoxScorePlayers(feed, 'fixture'), /Conflicting provider identity/)
    requests.length = 0
    assert.deepEqual(await resolveBoxScorePlayers({ gameStatus: 2 }, 'empty'), [])
    assert.equal(requests.length, 0)
  } finally {
    globalThis.fetch = nativeFetch
  }
})

Deno.test('a box side carries missing position metadata in the same identity import', async () => {
  const originalFetch = globalThis.fetch
  let records: unknown[] = []
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    assert.equal(new URL(request.url).pathname, '/rest/v1/rpc/resolve_player_imports_atomic')
    const body = await request.json()
    records = body.p_records
    return Response.json({ results: records.map((_row, index) => ({ index, player_id: 'box-player', action: 'updated' })), stale_draft_numbers_cleared: 0 })
  }
  try {
    await recordBoxSides({ homeTeam: { teamTricode: 'BOS', players: [{ personId: 123, name: 'Box Player', position: 'C' } as NBABoxScorePlayer] } }, '0022600001')
    assert.deepEqual(records, [{ provider_id: '123', display_name: 'Box Player', nba_game_id: '0022600001', nba_team: 'BOS', identity_only: true, metadata: { position: 'C' } }])
  } finally { globalThis.fetch = originalFetch }
})

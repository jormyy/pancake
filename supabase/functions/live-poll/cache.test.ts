import assert from 'node:assert/strict'
import type { NBABoxScore } from '../_shared/nba.ts'
import type { StatsSyncGame } from '../_shared/syncStats.ts'
import type { LiveFeedSnapshot } from '../_shared/liveFeed.ts'

Deno.env.set('SUPABASE_URL', 'http://database.invalid')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'fixture-key')
const { syncLiveStatsGames, buildStatRow } = await import('../_shared/syncStats.ts')
const { liveSnapshotKey } = await import('../_shared/liveFeed.ts')

const playerIds = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']
const statistics = { assists: 0, blocks: 0, fieldGoalsAttempted: 0, fieldGoalsMade: 0, foulsPersonal: 0, freeThrowsAttempted: 0, freeThrowsMade: 0, plusMinusPoints: 0, reboundsDefensive: 0, reboundsOffensive: 0, reboundsTotal: 0, steals: 0, threePointersAttempted: 0, threePointersMade: 0, turnovers: 0 }
const box = (): NBABoxScore => ({
  gameId: '0022600001', gameEt: null, gameStatus: 2, period: 1, gameClock: 'PT06M00.00S',
  sourceUpdatedAt: '2026-10-30T01:00:00Z', gameStatusText: 'Q1',
  homeTeam: { teamTricode: 'ATL', score: 10, players: [{ personId: 1, name: 'One Player', played: '1', statistics: { ...statistics, minutes: 'PT6M00S', points: 10 } }] },
  awayTeam: { teamTricode: 'CLE', score: 8, players: [{ personId: 2, name: 'Two Player', played: '1', statistics: { ...statistics, minutes: 'PT6M00S', points: 8 } }] },
})
const game = (): StatsSyncGame => ({ id: '00000000-0000-4000-8000-000000000003', nba_game_id: '0022600001', status: 'InProgress', season_year: 2027, week_number: 1 })

async function fixture(run: (game: StatsSyncGame, source: NBABoxScore, calls: string[], saves: LiveFeedSnapshot[]) => Promise<void>) {
  const current = game(), source = box(), calls: string[] = [], saves: LiveFeedSnapshot[] = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    assert.equal(url.hostname, 'database.invalid')
    const name = url.pathname.split('/').at(-1)!
    calls.push(name)
    if (name === 'assert_nba_game_unambiguous') return Response.json(null)
    if (name === 'resolve_player_imports_atomic') return Response.json({ results: playerIds.map((player_id, index) => ({ index, player_id, action: 'updated' })), stale_draft_numbers_cleared: 0 })
    assert.equal(name, 'save_live_feed_snapshot_atomic')
    const { p_snapshot: snapshot } = await request.json()
    saves.push(snapshot)
    const { full_stats, ...rest } = snapshot
    current.live_cache = { players: playerIds.map((player_id, index) => ({ provider_id: String(index + 1), player_id, nba_team: index ? 'CLE' : 'ATL' })), snapshot: { ...rest, stats: full_stats } }
    return Response.json(snapshot.stats.length)
  }
  try { await run(current, source, calls, saves) } finally { globalThis.fetch = original }
}

Deno.test('stored live receipts skip all database calls for an identical feed across ticks', async () => {
  await fixture(async (current, source, calls, saves) => {
    const first = await syncLiveStatsGames([current], { loadBoxScore: async () => source })
    assert.deepEqual(first.failures, [])
    assert.equal(first.statLines, 2)
    assert.deepEqual(calls, ['assert_nba_game_unambiguous', 'resolve_player_imports_atomic', 'save_live_feed_snapshot_atomic'])
    calls.length = 0
    const restarted = structuredClone(current)
    const second = await syncLiveStatsGames([restarted], { loadBoxScore: async () => source })
    assert.deepEqual(calls, [])
    assert.deepEqual(second, { statLines: 0, failures: [] })
    assert.equal(saves.length, 1)
  })
})

Deno.test('one changed player sends one changed line and keeps full recovery input', async () => {
  await fixture(async (current, source, calls, saves) => {
    await syncLiveStatsGames([current], { loadBoxScore: async () => source })
    calls.length = 0
    source.homeTeam.players[0].statistics.points = 12
    source.homeTeam.score = 12
    const result = await syncLiveStatsGames([current], { loadBoxScore: async () => source })
    assert.deepEqual(result, { statLines: 1, failures: [] })
    assert.deepEqual(calls, ['save_live_feed_snapshot_atomic'])
    assert.equal((saves[1].stats as unknown[]).length, 1)
    assert.equal((saves[1].full_stats as unknown[]).length, 2)
  })
})

Deno.test('a newer source revision advances the watermark with zero changed lines', async () => {
  await fixture(async (current, source, calls, saves) => {
    await syncLiveStatsGames([current], { loadBoxScore: async () => source })
    calls.length = 0
    source.sourceUpdatedAt = '2026-10-30T01:00:30Z'
    const result = await syncLiveStatsGames([current], { loadBoxScore: async () => source })
    assert.deepEqual(result, { statLines: 0, failures: [] })
    assert.deepEqual(calls, ['save_live_feed_snapshot_atomic'])
    assert.deepEqual(saves[1].stats, [])
  })
})

Deno.test('an unseen provider identity renews the complete identity receipt', async () => {
  await fixture(async (current, source, calls) => {
    await syncLiveStatsGames([current], { loadBoxScore: async () => source })
    calls.length = 0
    source.homeTeam.players[0].personId = 3
    await syncLiveStatsGames([current], { loadBoxScore: async () => source })
    assert.deepEqual(calls.slice(0, 2), ['assert_nba_game_unambiguous', 'resolve_player_imports_atomic'])
  })
})

Deno.test('snapshot comparison ignores only row write time and object field order', () => {
  const row = buildStatRow(box().homeTeam.players[0], playerIds[0], game().id, 2027, 1)
  assert.equal(liveSnapshotKey({ stats: [row] }), liveSnapshotKey({ stats: [{ ...row, updated_at: 'later' }] }))
  assert.notEqual(liveSnapshotKey({ stats: [row] }), liveSnapshotKey({ stats: [{ ...row, points: 11 }] }))
})

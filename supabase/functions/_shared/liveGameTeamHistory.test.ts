import { fetchCdnGameOrMiss } from './cdnGameFetch.ts'

Deno.test('CDN game sides survive identity resolution and both final and live stat saves', async () => {
  Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
  Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'game-side-test')
  const { resolveBoxScorePlayers, buildStatRow, saveGameStats } = await import('./syncStats.ts')
  const nativeFetch = globalThis.fetch
  const writes: { rpc: string; body: Record<string, unknown> }[] = []
  const statistics = { assists: 1, blocks: 0, fieldGoalsAttempted: 5, fieldGoalsMade: 2, foulsPersonal: 1,
    freeThrowsAttempted: 0, freeThrowsMade: 0, minutes: 'PT12M00.00S', plusMinusPoints: 0, points: 5,
    reboundsDefensive: 1, reboundsOffensive: 0, reboundsTotal: 1, steals: 0, threePointersAttempted: 2,
    threePointersMade: 1, turnovers: 1 }
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const rpc = url.pathname.split('/').at(-1)!
    if (url.pathname.includes('/boxscore/')) return Response.json({ game: { gameStatus: 3,
      homeTeam: { teamTricode: 'LAL', players: [{ personId: 1, name: 'Home Player', statistics }] },
      awayTeam: { teamTricode: 'BOS', players: [{ personId: 2, name: 'Away Player', statistics }] } } })
    const body = JSON.parse(String(init?.body))
    if (rpc === 'resolve_player_imports_atomic') return Response.json({ results: [
      { index: 0, player_id: 'home-player', action: 'updated' }, { index: 1, player_id: 'away-player', action: 'updated' },
    ], stale_draft_numbers_cleared: 0 })
    writes.push({ rpc, body })
    return Response.json(2)
  }
  try {
    const game = await fetchCdnGameOrMiss('002fixture', 'http://127.0.0.1:9')
    if (!game || game === 'missing') throw new Error('Missing fixture game')
    const resolved = await resolveBoxScorePlayers(game, '002fixture')
    const rows = resolved.map(({ player, playerId }) => buildStatRow(player, playerId, 'game', 2026, 1))
    if (rows[0].is_home !== true || rows[1].is_home !== false) throw new Error('Provider team grouping was lost')
    await saveGameStats('game', '002fixture', rows, true)
    await saveGameStats('game', '002fixture', rows, false, 720)
    if (writes.length !== 2 || writes[0].rpc !== 'save_game_stats_atomic' || writes[1].rpc !== 'save_live_game_stats_atomic') {
      throw new Error('Both ingestion paths must save the team side')
    }
    for (const write of writes) {
      const payload = write.body.p_stats as { is_home: boolean }[]
      if (payload[0].is_home !== true || payload[1].is_home !== false) throw new Error('Saved rows lose game team sides')
    }
    const unknown = buildStatRow({ personId: 3, name: 'Legacy Player', statistics }, 'legacy', 'game', 2026, 1)
    if (unknown.is_home !== null) throw new Error('Ungrouped imports must keep the team side unknown')
  } finally { globalThis.fetch = nativeFetch }
})

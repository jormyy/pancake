import { strict as assert } from 'node:assert'

Deno.env.set('SUPABASE_URL', 'http://database.invalid')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'fixture-key')
Deno.env.set('NBA_CDN_BASE_URL', 'http://nba.invalid')
const { syncNBAIds } = await import('./nbaIds.ts')

Deno.test('NBA links commit bounded batches and resume after a failed transaction', async () => {
  const originalFetch = globalThis.fetch
  const players = Array.from({ length: 125 }, (_, index) => ({
    id: String(index), display_name: `Fixture ${String.fromCharCode(65 + Math.floor(index / 26), 65 + index % 26)}`,
    nba_id: null as string | null, nba_team: 'BOS', position: 'G', eligible_positions: ['G'],
    years_exp: 5, espn_id: null, sleeper_id: null,
  }))
  const calls: string[][] = []
  let fail = true
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.hostname === 'nba.invalid') return Response.json({ resultSets: [{
      headers: ['PERSON_ID', 'PLAYER_FIRST_NAME', 'PLAYER_LAST_NAME', 'ROSTER_STATUS', 'TEAM_ABBREVIATION', 'POSITION'],
      rowSet: players.map(player => [player.id, 'Fixture', player.display_name.split(' ')[1], 1, 'BOS', 'G']),
    }] })
    assert.equal(url.hostname, 'database.invalid')
    if (url.pathname.endsWith('/link_player_sources_atomic')) {
      const body = await request.json()
      const ids = body.p_records.map((row: { provider_id: string }) => row.provider_id)
      calls.push(ids)
      if (calls.length === 2 && fail) return Response.json({ message: 'canceling statement due to statement timeout' }, { status: 500 })
      for (const id of ids) players[Number(id)].nba_id = id
      return Response.json({ results: ids.map((id: string, index: number) => ({ index, player_id: id, action: 'updated' })) })
    }
    if (url.pathname.endsWith('/merge_duplicate_players')) return Response.json(0)
    assert.equal(url.pathname, '/rest/v1/players')
    return Response.json(players)
  }
  try {
    await assert.rejects(syncNBAIds(), /Link nba players: canceling statement due to statement timeout/)
    assert.equal(players.filter(player => player.nba_id !== null).length, 50)
    fail = false
    const retried = await syncNBAIds()
    assert.equal(retried.mapped, 75)
    assert.ok(calls.every(batch => batch.length <= 50))
    assert.ok(calls.slice(2).flat().every(id => Number(id) >= 50))
    assert.equal(players.filter(player => player.nba_id !== null).length, 125)
  } finally { globalThis.fetch = originalFetch }
})

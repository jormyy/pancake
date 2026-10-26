import { strict as assert } from 'node:assert'

Deno.env.set('SUPABASE_URL', 'http://database.invalid')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'fixture-key')
Deno.env.set('NBA_CDN_BASE_URL', 'http://nba.invalid')
const fixture = JSON.parse(await Deno.readTextFile(new URL('./fixtures/nba-index-beringer.json', import.meta.url)))
const { syncNBAIds } = await import('./nbaIds.ts')

Deno.test('the NBA first-season field repairs experience missing from both player feeds', async () => {
  const originalFetch = globalThis.fetch
  const updates: { id: string | null; body: unknown }[] = []
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.hostname === 'nba.invalid') return Response.json(fixture)
    assert.equal(url.hostname, 'database.invalid')
    if (url.pathname === '/rest/v1/rpc/link_player_sources_atomic') return Response.json({ results: [{ index: 0, player_id: 'beringer', action: 'updated' }] })
    if (url.pathname === '/rest/v1/rpc/merge_duplicate_players') return Response.json(null)
    assert.equal(url.pathname, '/rest/v1/players')
    if (request.method === 'PATCH') {
      updates.push({ id: url.searchParams.get('id'), body: await request.json() })
      assert.equal(url.searchParams.get('years_exp'), 'is.null')
      assert.equal(url.searchParams.get('nba_id'), 'eq.1642866')
      return new Response(null, { status: 204 })
    }
    return Response.json([{ id: 'beringer', display_name: 'Joan Beringer', nba_id: '1642866', years_exp: null }])
  }
  try {
    await syncNBAIds(new Date('2025-10-25T16:00:00Z'))
    assert.deepEqual(updates, [{ id: 'eq.beringer', body: { years_exp: 0 } }])
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test('NBA roster identities use team context and provide missing position and experience', async () => {
  const originalFetch = globalThis.fetch
  const calls: Record<string, unknown>[] = []
  const players = [
    { id: 'min', display_name: 'Joan Beringer', nba_team: 'MIN', nba_id: null as string | null, years_exp: 0 },
    { id: 'bos', display_name: 'Joan Beringer', nba_team: 'BOS', nba_id: null as string | null, years_exp: 3 },
  ]
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.hostname === 'nba.invalid') return Response.json(fixture)
    if (url.pathname.endsWith('/link_player_sources_atomic')) {
      const body = await request.json()
      calls.push(body)
      players[0].nba_id = '1642866'
      return Response.json({ results: [{ index: 0, player_id: 'min', action: 'updated' }] })
    }
    if (url.pathname.endsWith('/merge_duplicate_players')) return Response.json(null)
    assert.equal(url.pathname, '/rest/v1/players')
    return Response.json(players)
  }
  try {
    await syncNBAIds(new Date('2026-10-25T16:00:00Z'))
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], { p_source: 'nba', p_current_roster: false, p_records: [{
      provider_id: '1642866', display_name: 'Joan Beringer', nba_team: 'MIN', years_exp: 1, position: 'F',
    }] })
    assert.equal(players[1].nba_id, null)
  } finally { globalThis.fetch = originalFetch }
})

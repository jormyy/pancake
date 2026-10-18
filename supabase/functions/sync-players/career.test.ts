import { strictEqual as assertEquals, ok as assert } from 'node:assert'

Deno.test('career sync stores verified NBA regular-season aggregates and clears unknown counts', async () => {
  const updates: { id: string; body: Record<string, unknown> }[] = []
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (request) => {
    const url = new URL(request.url)
    if (url.pathname === '/rest/v1/players') {
      if (request.method === 'PATCH') {
        updates.push({ id: url.searchParams.get('id') ?? '', body: await request.json() })
        return new Response(null, { status: 204 })
      }
      return Response.json([
        { id: 'known', espn_id: '64' }, { id: 'unavailable', espn_id: 'missing' },
        { id: 'postseason', espn_id: 'postseason' }, { id: 'unmapped', espn_id: null },
      ])
    }
    assertEquals(url.searchParams.get('seasontype'), '2')
    if (url.pathname.includes('/missing/')) return new Response('missing', { status: 404 })
    return Response.json({
      filters: [{ name: 'league', value: 'nba' }, { name: 'seasontype', value: url.pathname.includes('/postseason/') ? '3' : '2' }],
      categories: [{ names: ['gamesPlayed'], totals: ['64'] }],
    })
  })
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`
  const keys = ['SUPABASE_URL', 'PANCAKE_SUPABASE_SECRET_KEY', 'ESPN_CAREER_BASE_URL']
  const prior = keys.map((key) => Deno.env.get(key))
  Deno.env.set('SUPABASE_URL', base)
  Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'synthetic-career-test-key')
  Deno.env.set('ESPN_CAREER_BASE_URL', base)
  try {
    const { syncCareerGames } = await import('./career.ts')
    const result = await syncCareerGames()
    assertEquals(result.updated, 3)
    assertEquals(result.failures.length, 1)
    assertEquals(updates.find((row) => row.id === 'eq.known')?.body.career_regular_season_games, 64)
    assertEquals(updates.find((row) => row.id === 'eq.unavailable')?.body.career_regular_season_games, null)
    assertEquals(updates.find((row) => row.id === 'eq.postseason')?.body.career_regular_season_games, null)
    assert(updates.every((row) => typeof row.body.career_games_checked_at === 'string'))
  } finally {
    await server.shutdown()
    keys.forEach((key, index) => { if (prior[index] == null) Deno.env.delete(key); else Deno.env.set(key, prior[index]!) })
  }
})

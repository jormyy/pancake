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

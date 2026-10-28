import assert from 'node:assert/strict'

Deno.env.set('SUPABASE_URL', 'http://database.invalid')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'fixture-key')
Deno.env.set('SLEEPER_BASE_URL', 'http://source.invalid')
const { syncSleeperLinks } = await import('./sleeperLinks.ts')

Deno.test('a 503 defers identity refresh without writes and the next refresh retries', async () => {
  const originalFetch = globalThis.fetch
  const player = { id: 'player', display_name: 'Later Source', nba_team: 'BOS', nba_id: '1', espn_id: null,
    sleeper_id: null as string | null, years_exp: 2, position: 'G', birthdate: '1990-01-01' }
  let status = 503
  let sourceCalls = 0
  let writes = 0
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.hostname === 'source.invalid') {
      sourceCalls++
      return status === 503 ? new Response(null, { status }) : Response.json({ one: {
        sport: 'nba', player_id: '1', first_name: 'Later', last_name: 'Source', team: 'BOS', position: 'G', years_exp: 2,
      } })
    }
    if (url.pathname.endsWith('/link_player_sources_atomic')) {
      writes++
      player.sleeper_id = '1'
      return Response.json({ results: [{ index: 0, player_id: player.id, action: 'updated' }] })
    }
    assert.equal(url.pathname, '/rest/v1/players')
    return Response.json([player])
  }
  try {
    assert.deepEqual(await syncSleeperLinks(), { linked: 0, birthdatesUpdated: 0, deferred: true, failures: [] })
    assert.equal(writes, 0)
    assert.equal(sourceCalls, 2)
    status = 200
    assert.deepEqual(await syncSleeperLinks(), { linked: 1, birthdatesUpdated: 0, deferred: false, failures: [] })
    assert.equal(sourceCalls, 3)
    assert.equal(writes, 1)
  } finally { globalThis.fetch = originalFetch }
})

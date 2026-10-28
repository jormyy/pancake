import { strict as assert } from 'node:assert'

Deno.test('a rejected Brown identity blocks roster cleanup', async () => {
  const calls: string[] = []
  const upstream = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, request => {
    calls.push(new URL(request.url).pathname)
    return Response.json({ results: [{ index: 0, player_id: null, action: 'ambiguous' }], stale_draft_numbers_cleared: 0 })
  })
  Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(upstream.addr as Deno.NetAddr).port}`)
  Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_fixture')
  try {
    const { importPlayerChunk } = await import('./imports.ts')
    const { completeRosterCycle, releaseUnlistedPlayers } = await import('./release.ts')
    const result = await importPlayerChunk('espn', [{ provider_id: '3917376', first_name: 'Jalen', last_name: 'Brown', metadata: { nba_team: 'BOS' } }], 0)
    assert.equal(result.ambiguousSkipped, 1)
    assert.equal(result.failures.length, 1)
    assert.match(result.failures[0], /3917376.*ambiguous identity/)
    const listing = [{ espn_id: '3917376', first_name: 'Jalen', last_name: 'Brown', nba_team: 'BOS' }]
    const release = await releaseUnlistedPlayers(listing, [], result.failures, [])
    assert.equal(release.released, 0)
    assert.deepEqual(release.blockers, ['1 import failure(s)'])
    const cycle = await completeRosterCycle(listing, [], result.failures, { roster: [], rosterGaps: [] }, new Date())
    assert.equal(cycle.released, 0)
    assert.deepEqual(calls, ['/rest/v1/rpc/resolve_player_imports_atomic'])
  } finally {
    await upstream.shutdown()
  }
})

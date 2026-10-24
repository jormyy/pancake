import { strict as assert } from 'node:assert'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'local-resolver-test')
const { resolveCdnPlayers } = await import('./playerResolver.ts')

// HTTP contract tests only. Matching, claims, and rollback run against real SQL
// in tests/db/player-imports.sql and the concurrent importer regression.
async function withImports(replies: (string | Error)[], run: () => Promise<void>) {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/rest/v1/players') {
      return Response.json([{ id: 'before-merge', display_name: 'Shared Name', nba_id: 'nba-id' }])
    }
    assert.equal(url.pathname, '/rest/v1/rpc/resolve_player_imports_atomic')
    assert.equal(request.method, 'POST')
    const body = await request.json()
    assert.equal(body.p_source, 'nba_cdn')
    assert.equal(body.p_records.length, 1)
    assert.equal(body.p_records[0].provider_id, 'nba-id')
    const reply = replies[calls++]
    assert.ok(reply, 'Unexpected extra import request')
    return reply instanceof Error
      ? Response.json({ message: reply.message, code: 'TEST' }, { status: 400 })
      : Response.json({ results: [{ index: 0, player_id: reply, action: 'updated' }], stale_draft_numbers_cleared: 0 })
  }
  try { await run(); assert.equal(calls, replies.length) }
  finally { globalThis.fetch = original }
}

Deno.test('CDN resolution propagates a provider conflict without returning a cached player', async () => {
  await withImports([new Error('Conflicting provider identity')], async () => {
    await assert.rejects(() => resolveCdnPlayers([{ personId: 'nba-id', displayName: 'Shared Name' }]), /Conflicting provider identity/)
  })
})

Deno.test('CDN resolution confirms the canonical identity on every call', async () => {
  await withImports(['current', 'current'], async () => {
    assert.deepEqual(await resolveCdnPlayers([{ personId: 'nba-id', displayName: 'Shared Name' }]), ['current'])
    assert.deepEqual(await resolveCdnPlayers([{ personId: 'nba-id', displayName: 'New Display' }]), ['current'])
  })
})

Deno.test('CDN resolution returns the survivor after an intervening merge', async () => {
  await withImports(['first', 'survivor'], async () => {
    assert.deepEqual(await resolveCdnPlayers([{ personId: 'nba-id', displayName: 'Shared Name' }]), ['first'])
    assert.deepEqual(await resolveCdnPlayers([{ personId: 'nba-id', displayName: 'Shared Name' }]), ['survivor'])
  })
})

Deno.test('failed CDN resolution never recovers through an earlier cached success', async () => {
  await withImports(['first', new Error('creation unavailable')], async () => {
    assert.deepEqual(await resolveCdnPlayers([{ personId: 'nba-id', displayName: 'Shared Name' }]), ['first'])
    await assert.rejects(() => resolveCdnPlayers([{ personId: 'nba-id', displayName: 'Shared Name' }]), /creation unavailable/)
  })
})

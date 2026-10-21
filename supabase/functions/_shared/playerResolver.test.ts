import { strict as assert } from 'node:assert'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'local-resolver-test')
const { loadCdnPlayerResolver, resolveCdnPlayers } = await import('./playerResolver.ts')

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
    const resolver = await loadCdnPlayerResolver()
    await assert.rejects(() => resolveCdnPlayers(resolver, [{ personId: 'nba-id', displayName: 'Shared Name' }]), /Conflicting provider identity/)
  })
})

Deno.test('CDN resolution confirms the canonical identity on every call', async () => {
  await withImports(['current', 'current'], async () => {
    const resolver = await loadCdnPlayerResolver()
    assert.deepEqual(await resolveCdnPlayers(resolver, [{ personId: 'nba-id', displayName: 'Shared Name' }]), ['current'])
    assert.deepEqual(await resolveCdnPlayers(resolver, [{ personId: 'nba-id', displayName: 'New Display' }]), ['current'])
  })
})

Deno.test('a stale CDN resolver returns the survivor after an intervening merge', async () => {
  await withImports(['first', 'survivor'], async () => {
    const resolver = await loadCdnPlayerResolver()
    assert.deepEqual(await resolveCdnPlayers(resolver, [{ personId: 'nba-id', displayName: 'Shared Name' }]), ['first'])
    assert.deepEqual(await resolveCdnPlayers(resolver, [{ personId: 'nba-id', displayName: 'Shared Name' }]), ['survivor'])
    assert.equal(resolver.byNbaId.get('nba-id'), 'survivor')
  })
})

Deno.test('failed CDN resolution never recovers through an earlier cached success', async () => {
  await withImports(['first', new Error('creation unavailable')], async () => {
    const resolver = await loadCdnPlayerResolver()
    assert.deepEqual(await resolveCdnPlayers(resolver, [{ personId: 'nba-id', displayName: 'Shared Name' }]), ['first'])
    await assert.rejects(() => resolveCdnPlayers(resolver, [{ personId: 'nba-id', displayName: 'Shared Name' }]), /creation unavailable/)
  })
})

const { resolvePlayerImports } = await import('./playerImports.ts')
const retryRecords = [{ provider_id: 'nba-id', display_name: 'Shared Name' }]

async function withImportFailures(codes: string[], run: (state: { calls: number; warnings: string[] }) => Promise<void>) {
  const originalFetch = globalThis.fetch
  const originalWarn = console.warn
  const state = { calls: 0, warnings: [] as string[] }
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    assert.equal(new URL(request.url).pathname, '/rest/v1/rpc/resolve_player_imports_atomic')
    assert.deepEqual(await request.json(), { p_source: 'nba_cdn', p_records: retryRecords })
    const code = codes[state.calls++]
    return code !== undefined
      ? Response.json({ message: `Synthetic database ${code}`, code }, { status: 500 })
      : Response.json({ results: [{ index: 0, player_id: 'canonical', action: 'updated' }], stale_draft_numbers_cleared: 0 })
  }
  console.warn = (...args: unknown[]) => { state.warnings.push(args.join(' ')) }
  try { await run(state) }
  finally { globalThis.fetch = originalFetch; console.warn = originalWarn }
}

Deno.test('atomic player imports retry deadlocks and serialization failures after rollback', async () => {
  for (const code of ['40P01', '40001']) {
    await withImportFailures([code], async state => {
      const result = await resolvePlayerImports('nba_cdn', retryRecords)
      assert.equal(result.results[0].player_id, 'canonical')
      assert.equal(state.calls, 2)
      assert.equal(state.warnings.length, 1)
      assert.match(state.warnings[0], new RegExp(`${code}.*1/3`))
    })
  }
})

Deno.test('atomic player import retries stop after three retries and log every retry', async () => {
  for (const code of ['40P01', '40001']) {
    await withImportFailures(Array(8).fill(code), async state => {
      await assert.rejects(() => resolvePlayerImports('nba_cdn', retryRecords), new RegExp(`Synthetic database ${code}`))
      assert.equal(state.calls, 4)
      assert.equal(state.warnings.length, 3)
      for (let index = 0; index < 3; index++) assert.match(state.warnings[index], new RegExp(`${code}.*${index + 1}/3`))
    })
  }
})

Deno.test('atomic player imports never retry identity, validation, permission, source-lock or unknown failures', async () => {
  for (const code of ['23514', '22023', '42501', 'PT409', 'PGRST301', '40P01-other', 'UNKNOWN', '']) {
    await withImportFailures([code], async state => {
      await assert.rejects(() => resolvePlayerImports('nba_cdn', retryRecords), /Synthetic database/)
      assert.equal(state.calls, 1)
      assert.equal(state.warnings.length, 0)
    })
  }
})

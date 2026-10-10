import { strict as assert } from 'node:assert'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'local-resolver-test')
const { loadCdnPlayerResolver, resolveCdnPlayer } = await import('./playerResolver.ts')

type Player = { id: string; display_name: string; nba_id: string | null }

async function withPlayers(rows: Player[], run: () => Promise<void>, failCreate = false) {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    assert.equal(url.pathname, '/rest/v1/players')
    if (request.method === 'POST') {
      assert.equal(failCreate, true)
      return Response.json({ message: 'creation unavailable', code: 'TEST' }, { status: 400 })
    }
    const matched = rows.filter((row) =>
      (!url.searchParams.has('id') || url.searchParams.get('id') === `eq.${row.id}`)
      && (!url.searchParams.has('nba_id')
        || url.searchParams.get('nba_id') === `eq.${row.nba_id}`
        || (url.searchParams.get('nba_id') === 'is.null' && row.nba_id === null))
    )
    if (request.method === 'PATCH') {
      const update = await request.json()
      for (const row of matched) row.nba_id = update.nba_id
    } else {
      assert.equal(request.method, 'GET')
    }
    return Response.json(request.headers.get('Accept')?.includes('vnd.pgrst.object')
      ? matched[0] ?? null : matched)
  }
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
}

Deno.test('CDN name matching rejects a different assigned provider identity', async () => {
  const row = { id: 'existing', display_name: 'Shared Name', nba_id: 'old-id' }
  await withPlayers([row], async () => {
    const resolver = await loadCdnPlayerResolver()
    await assert.rejects(() => resolveCdnPlayer(resolver, 'new-id', 'Shared Name'), /Conflicting NBA identity/)
    assert.equal(row.nba_id, 'old-id')
    assert.equal(resolver.byNbaId.has('new-id'), false)
  })
})

Deno.test('CDN name matching persists an unassigned identity before returning it for stats', async () => {
  const row: Player = { id: 'existing', display_name: 'Shared Name', nba_id: null }
  await withPlayers([row], async () => {
    const resolver = await loadCdnPlayerResolver()
    assert.equal(await resolveCdnPlayer(resolver, 'new-id', 'Shared Name'), row.id)
    assert.equal(row.nba_id, 'new-id')
    assert.equal(await resolveCdnPlayer(resolver, 'new-id', 'New Display'), row.id)
    await assert.rejects(() => resolveCdnPlayer(resolver, 'other-id', 'Shared Name'), /Conflicting NBA identity/)
    assert.equal(row.nba_id, 'new-id')
  })
})

Deno.test('a stale resolver cannot replace an identity claimed by another worker', async () => {
  const row: Player = { id: 'existing', display_name: 'Shared Name', nba_id: null }
  await withPlayers([row], async () => {
    const resolver = await loadCdnPlayerResolver()
    row.nba_id = 'other-worker-id'
    await assert.rejects(() => resolveCdnPlayer(resolver, 'new-id', 'Shared Name'), /Conflicting NBA identity/)
    assert.equal(row.nba_id, 'other-worker-id')
  })
})

Deno.test('failed creation cannot recover through a namesake with a different provider ID', async () => {
  const rows: Player[] = []
  await withPlayers(rows, async () => {
    const resolver = await loadCdnPlayerResolver()
    rows.push({ id: 'namesake', display_name: 'Shared Name', nba_id: 'other-id' })
    await assert.rejects(() => resolveCdnPlayer(resolver, 'new-id', 'Shared Name'), /creation unavailable/)
  }, true)
})

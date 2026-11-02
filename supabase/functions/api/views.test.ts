import { strict as assert } from 'node:assert'

const league = '10000000-0000-4000-8000-000000000001'
const member = '10000000-0000-4000-8000-000000000002'
const user = '10000000-0000-4000-8000-000000000003'
const calls: { name: string; args: Record<string, unknown>; authorization: string | null }[] = []
let snapshot: Record<string, unknown> = { matchup: { myPoints: 102.25 }, roster: [], claims: [{ bidAmount: 13 }], version: 12 }
const backend = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async request => {
  const path = new URL(request.url).pathname
  if (path === '/auth/v1/user') return Response.json({ id: user })
  assert.ok(path.startsWith('/rest/v1/rpc/view_'))
  calls.push({ name: path.split('/').at(-1)!, args: await request.json(), authorization: request.headers.get('authorization') })
  return Response.json(snapshot)
})
Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(backend.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_view_fixture')
const { handleViewRoute } = await import('./views/index.ts')
const { screenViews } = await import('../_shared/views.ts')

function request(screen: string, params: unknown = {}) {
  const url = new URL(`http://localhost/views/${screen}`)
  url.searchParams.set('leagueId', league)
  url.searchParams.set('memberId', member)
  url.searchParams.set('params', JSON.stringify(params))
  return new Request(url, { headers: { authorization: 'Bearer screen-fixture-user' } })
}

Deno.test('each screen uses one RPC with the user bearer and preserves the complete snapshot', async () => {
  for (const [screen, rpc] of Object.entries(screenViews)) {
    const before = calls.length
    const response = await handleViewRoute(request(screen, { date: '2026-10-27' }), `/views/${screen}`)
    assert.equal(response?.status, 200)
    assert.deepEqual(await response!.json(), { ok: true, view: snapshot })
    assert.equal(calls.length, before + 1)
    assert.deepEqual(calls.at(-1), { name: rpc, args: {
      p_league_id: league, p_member_id: member, p_params: { date: '2026-10-27' },
    }, authorization: 'Bearer screen-fixture-user' })
  }
})

Deno.test('worker and helper names are not exposed as screen routes', async () => {
  for (const screen of ['refresh-work', 'context', 'player-search', 'game-day', 'transaction-state', 'trade-preview', '__proto__', 'home/extra']) {
    assert.equal(await handleViewRoute(request(screen), `/views/${screen}`), null)
  }
  assert.equal(await handleViewRoute(new Request('http://localhost/views/home', { method: 'POST' }), '/views/home'), null)
})

Deno.test('invalid parameters fail before reading a screen', async () => {
  const before = calls.length
  for (const params of [null, [], 1, 'home']) {
    await assert.rejects(() => handleViewRoute(request('home', params), '/views/home'), /JSON object/)
  }
  await assert.rejects(() => handleViewRoute(new Request(`http://localhost/views/home?leagueId=${league}&memberId=invalid`), '/views/home'), /memberId/)
  const malformed = request('home')
  const malformedUrl = new URL(malformed.url)
  malformedUrl.searchParams.set('params', '{')
  await assert.rejects(() => handleViewRoute(new Request(malformedUrl), '/views/home'), /JSON object/)
  assert.equal(calls.length, before)
})

Deno.test('profile supports a signed-in user without league membership', async () => {
  const response = await handleViewRoute(new Request('http://localhost/views/profile', {
    headers: { authorization: 'Bearer screen-fixture-user' },
  }), '/views/profile')
  assert.equal(response?.status, 200)
  assert.deepEqual(calls.at(-1)?.args, { p_league_id: null, p_member_id: null, p_params: {} })
})

Deno.test('missing authentication cannot read a view', async () => {
  await assert.rejects(() => handleViewRoute(new Request(request('home').url), '/views/home'), /Authorization/)
})

Deno.test('a complete requested matchup returns through one authorized screen read', async () => {
  const previous = snapshot
  const matchupId = 'a0000000-0000-4000-8000-000000000004'
  snapshot = { context: { seasonId: league, seasonYear: 2026, weekNumber: 2 }, matchup: { id: matchupId, myPoints: 15 },
    leagueMatchups: [{ id: matchupId, homeMemberId: member, awayMemberId: user }],
    todaysGames: [{ id: matchupId, game_time: '2026-10-27T23:00:00Z' }], liveBasis: [{ id: matchupId, players: [] }] }
  const before = calls.length
  try {
    const response = await handleViewRoute(request('home', { matchupId: matchupId.toUpperCase() }), '/views/home')
    assert.equal(response?.status, 200)
    assert.deepEqual(await response!.json(), { ok: true, view: snapshot })
    assert.equal(calls.length, before + 1)
  } finally { snapshot = previous }
})

Deno.test('an unavailable requested matchup cannot fall back to another score', async () => {
  await assert.rejects(() => handleViewRoute(request('home', { matchupId: league }), '/views/home'), /not available/)
})

Deno.test({ name: 'close screen view test server', sanitizeOps: false, sanitizeResources: false, fn: () => backend.shutdown() })

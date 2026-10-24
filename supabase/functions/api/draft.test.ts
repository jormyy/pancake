import { strict as assert } from 'node:assert'

const USER = '22222222-2222-4222-8222-222222222222'
const MEMBER = '33333333-3333-4333-8333-333333333333'
const DRAFT = '44444444-4444-4444-8444-444444444444'
const PLAYER = '55555555-5555-4555-8555-555555555555'
const LEAGUE = '66666666-6666-4666-8666-666666666666'
let role: string | null = 'manager'
let isMock = false
let activated = false
const requests: string[] = []
const rpcCalls: { name: string; body: Record<string, unknown> }[] = []
const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async req => {
  const url = new URL(req.url)
  requests.push(`${url.pathname}?${url.searchParams}`)
  const select = url.searchParams.get('select')
  let data: unknown = []
  if (url.pathname === '/auth/v1/user') data = { id: USER, aud: 'authenticated', role: 'authenticated' }
  if (url.pathname === '/rest/v1/drafts') data = { id: DRAFT, league_id: LEAGUE }
  if (url.pathname === '/rest/v1/league_members') {
    data = url.searchParams.has('role') ? role === 'commissioner' ? [{ league_id: LEAGUE }] : []
      : role ? { id: MEMBER, league_id: LEAGUE, user_id: USER, role } : null
  }
  if (url.pathname === '/rest/v1/leagues') data = { roster_size: 20, taxi_slots: 2 }
  if (url.pathname === '/rest/v1/players') data = { display_name: 'Rookie' }
  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const name = url.pathname.split('/').at(-1)!
    const body = await req.json() as Record<string, unknown>
    rpcCalls.push({ name, body })
    if (name === 'activate_rookie_draft_league_for_user_atomic') { activated = true; data = true }
    else data = {
      pick: { id: 'pick', overall_pick: 1, round: 1, pick_in_round: 1, member_id: MEMBER, draft_pick_id: null },
      player_id: PLAYER, remaining: 0, league_id: LEAGUE, league_season_id: 'season', is_mock: isMock,
    }
  }
  if (url.pathname === '/rest/v1/profiles') data = { push_token: null }
  return Response.json(data, { headers: select === 'id' && url.pathname === '/rest/v1/roster_players' ? { 'content-range': '0-0/0' } : {} })
})
Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
Deno.env.set('WEB_PUSH_VAPID_PUBLIC_KEY', '')
const { handleDraftRoute } = await import('./draft.ts')

async function action(name: string) {
  requests.length = 0
  rpcCalls.length = 0
  const path = `/draft/${DRAFT}/${name}`
  return await handleDraftRoute(new Request(`http://localhost${path}`, {
    method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
    body: JSON.stringify({ memberId: MEMBER, playerId: PLAYER, userId: 'forged' }),
  }), path)
}

Deno.test('an ordinary league manager can trigger readiness-gated activation using their authenticated identity', async () => {
  role = 'manager'
  activated = false
  const response = await action('activate-rookie-league')
  assert.equal(response?.status, 200)
  assert.equal(activated, true)
  assert.deepEqual(rpcCalls, [{ name: 'activate_rookie_draft_league_for_user_atomic', body: { p_draft_id: DRAFT, p_user_id: USER } }])
})

Deno.test('an outsider cannot trigger rookie activation', async () => {
  role = null
  await assert.rejects(action('activate-rookie-league'), /Draft not found/)
  assert.equal(rpcCalls.length, 0)
})

Deno.test('manual and self auto-picks return without reading notification recipients or player names', async () => {
  role = 'manager'
  isMock = false
  for (const name of ['snake-pick', 'auto-pick']) {
    const response = await action(name)
    assert.equal(response?.status, 200)
    assert.equal(requests.some(path => path.startsWith('/rest/v1/players')), false)
    assert.equal(requests.some(path => path.includes('select=user_id')), false)
    assert.equal(requests.some(path => path.includes('notification_preferences')), false)
  }
})

Deno.test('commissioner picks still notify the roster owner, except in mock drafts', async () => {
  role = 'commissioner'
  isMock = false
  const response = await action('commissioner-pick')
  assert.equal(response?.status, 200)
  assert.equal(requests.some(path => path.includes('select=user_id')), true)
  isMock = true
  await action('commissioner-pick')
  assert.equal(requests.some(path => path.includes('select=user_id')), false)
})

Deno.test({ name: 'draft test server closes', sanitizeOps: false, sanitizeResources: false, fn: () => server.shutdown() })

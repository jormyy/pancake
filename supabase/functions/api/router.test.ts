const USER_ID = '22222222-2222-4222-8222-222222222222'
const MEMBER_ID = '33333333-3333-4333-8333-333333333333'
const DRAFT_ID = '44444444-4444-4444-8444-444444444444'
const PLAYER_ID = '55555555-5555-4555-8555-555555555555'
const LEAGUE_ID = '66666666-6666-4666-8666-666666666666'

const postgrestRequests: string[] = []

const postgrest = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (req) => {
  const url = new URL(req.url)
  postgrestRequests.push(`${req.method} ${url.pathname}?${url.searchParams.toString()}`)

  let body: unknown = []
  if (url.pathname === '/auth/v1/user') {
    body = {
      id: USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'mock-snake-pick@example.com',
    }
  } else if (url.pathname === '/rest/v1/league_members' && url.searchParams.get('select') === 'league_id') {
    body = { league_id: LEAGUE_ID }
  } else if (url.pathname === '/rest/v1/league_members' && url.searchParams.get('select') === 'role') {
    body = { role: 'commissioner' }
  } else if (url.pathname === '/rest/v1/rpc/make_snake_pick_atomic') {
    body = {
      pick: {
        id: '77777777-7777-4777-8777-777777777777',
        overall_pick: 1,
        round: 1,
        pick_in_round: 1,
        member_id: MEMBER_ID,
        draft_pick_id: null,
      },
      remaining: 0,
      league_id: LEAGUE_ID,
      league_season_id: '88888888-8888-4888-8888-888888888888',
      is_mock: true,
    }
  }

  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
    },
  })
})

Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(postgrest.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
Deno.env.set('E2E_ADMIN_SECRET', 'e2e-test-secret')

const { handleApiRoute } = await import('./router.ts')

const API = 'http://localhost/functions/v1/api'
const UUID = '11111111-1111-4111-8111-111111111111'

function request(method: string, path: string, body: Record<string, unknown> = {}): Request {
  return new Request(`${API}${path}`, {
    method,
    headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  })
}

function authedRequest(method: string, path: string, body: Record<string, unknown> = {}): Request {
  const req = request(method, path, body)
  req.headers.set('authorization', 'Bearer test-token')
  return req
}

Deno.test({
  name: 'API router returns health without hitting fallback 404',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const res = await handleApiRoute(request('GET', '/health'))
    const body = await res.json()

    if (res.status !== 200 || body.runtime !== 'supabase-edge') {
      throw new Error(`expected health 200, got ${res.status}: ${JSON.stringify(body)}`)
    }
  },
})

Deno.test({
  name: 'migrated API routes are wired before the fallback 404',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const routes = [
      ['GET', '/games/today'],
      ['GET', '/players/headshot/1641705'],
      ['POST', '/league/roster/ir'],
      ['POST', '/league/roster/taxi'],
      ['POST', '/league/advance-season'],
      ['POST', '/waivers/claims'],
      ['POST', `/waivers/claims/${UUID}/cancel`],
      ['POST', '/waivers/process'],
      ['POST', '/trades/propose'],
      ['POST', `/trades/${UUID}/accept`],
      ['POST', `/trades/${UUID}/reject`],
      ['POST', `/trades/${UUID}/withdraw`],
      ['POST', `/trades/${UUID}/veto`],
      ['POST', '/draft/start'],
      ['POST', '/draft/start-rookie'],
      ['POST', `/draft/${UUID}/stop`],
      ['POST', `/draft/${UUID}/reset`],
      ['POST', `/draft/${UUID}/nominate`],
      ['POST', `/draft/${UUID}/bid`],
      ['POST', `/draft/${UUID}/withdraw-nomination`],
      ['POST', `/draft/${UUID}/snake-pick`],
      ['POST', `/draft/${UUID}/commissioner-pick`],
      ['POST', `/draft/${UUID}/auto-pick`],
      ['POST', `/draft/${UUID}/process-expired-pick`],
      ['POST', `/draft/${UUID}/activate-rookie-league`],
      ['POST', `/draft/${UUID}/reseed-picks`],
      ['POST', '/playoffs/generate'],
      ['POST', '/playoffs/advance'],
      ['POST', '/sync/stats'],
      ['POST', '/sync/scores'],
      ['POST', '/sync/schedule'],
      ['POST', '/sync/matchups'],
      ['POST', '/sync/players'],
      ['POST', '/sync/rankings'],
      ['POST', '/sync/projections'],
      ['POST', '/sync/draft-order'],
      ['POST', '/sync/backfill'],
      ['POST', '/sync/test-endpoints'],
      ['POST', '/sync/verify-stats'],
      ['GET', '/sync/season-totals'],
      ['POST', '/sync/validate-db'],
      ['GET', '/e2e/status'],
      ['POST', '/e2e/process-waivers'],
      ['POST', '/e2e/process-trades'],
      ['POST', '/e2e/close-expired-nominations'],
    ] as const

    const failures = []
    for (const [method, path] of routes) {
      const res = await handleApiRoute(request(method, path))
      if (res.status === 404) failures.push(`${method} ${path}`)
    }

    if (failures.length > 0) {
      throw new Error(`routes hit fallback 404: ${failures.join(', ')}`)
    }
  },
})

Deno.test({
  name: 'mock snake picks skip real roster overflow and notification side effects',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    postgrestRequests.length = 0

    const res = await handleApiRoute(authedRequest('POST', `/draft/${DRAFT_ID}/snake-pick`, {
      memberId: MEMBER_ID,
      playerId: PLAYER_ID,
    }))
    const body = await res.json()

    if (res.status !== 200 || body.isMock !== true || body.rosterOverflow !== false) {
      throw new Error(`expected mock snake pick 200 without overflow, got ${res.status}: ${JSON.stringify(body)}`)
    }

    const forbiddenPaths = ['/rest/v1/leagues', '/rest/v1/roster_players', '/rest/v1/players', '/rest/v1/profiles']
    const forbidden = postgrestRequests.filter((entry) => forbiddenPaths.some((path) => entry.includes(path)))
    if (forbidden.length > 0) {
      throw new Error(`mock snake pick touched real roster/notification paths: ${forbidden.join(', ')}`)
    }
  },
})

Deno.test({
  name: 'draft start routes reject malformed isMock flags',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    for (const path of ['/draft/start', '/draft/start-rookie']) {
      postgrestRequests.length = 0

      const res = await handleApiRoute(authedRequest('POST', path, {
        leagueId: LEAGUE_ID,
        isMock: 'false',
      }))
      const body = await res.json()

      if (res.status !== 400 || body.error !== 'isMock must be a boolean') {
        throw new Error(`expected ${path} to reject string isMock, got ${res.status}: ${JSON.stringify(body)}`)
      }

      const startRpc = postgrestRequests.find((entry) => entry.includes('/rest/v1/rpc/start_'))
      if (startRpc) throw new Error(`${path} called start RPC after malformed isMock: ${startRpc}`)
    }
  },
})

Deno.test({
  name: 'close API router test server',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => postgrest.shutdown(),
})

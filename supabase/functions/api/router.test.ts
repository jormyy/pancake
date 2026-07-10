const USER_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_USER_ID = '99999999-9999-4999-8999-999999999999'
const MEMBER_ID = '33333333-3333-4333-8333-333333333333'
const DRAFT_ID = '44444444-4444-4444-8444-444444444444'
const PLAYER_ID = '55555555-5555-4555-8555-555555555555'
const LEAGUE_ID = '66666666-6666-4666-8666-666666666666'

const postgrestRequests: string[] = []
const profileMutations: { query: string; body: unknown }[] = []
let commissionerRole: string | null = 'commissioner'
let authenticatedUserId = USER_ID

const postgrest = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (req) => {
  const url = new URL(req.url)
  postgrestRequests.push(`${req.method} ${url.pathname}?${url.searchParams.toString()}`)

  let body: unknown = []
  if (url.pathname === '/auth/v1/user') {
    body = {
      id: authenticatedUserId,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'mock-snake-pick@example.com',
    }
  } else if (url.pathname === '/rest/v1/league_members' && url.searchParams.get('select') === 'league_id') {
    body = { league_id: LEAGUE_ID }
  } else if (url.pathname === '/rest/v1/league_members' && url.searchParams.get('select') === 'role') {
    body = commissionerRole ? { role: commissionerRole } : null
  } else if (url.pathname === '/rest/v1/profiles' && req.method === 'PATCH') {
    profileMutations.push({ query: url.searchParams.toString(), body: await req.json() })
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
const { assertUuid } = await import('../_shared/apiRuntime.ts')

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
  name: 'UUID validation accepts canonical Postgres UUIDs',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => {
    assertUuid('00000000-0000-0000-0000-000000000000')
    assertUuid('018f784c-7f57-7000-9000-0123456789ab')

    let rejected = false
    try {
      assertUuid('not-a-uuid')
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error('expected non-canonical UUID to be rejected')
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
      ['POST', '/profile/push-token'],
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
  name: 'trade proposal payloads enforce item and participant caps before RPC execution',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const otherMemberId = '77777777-7777-4777-8777-777777777777'
    const baseBody = {
      leagueId: LEAGUE_ID,
      leagueSeasonId: '88888888-8888-4888-8888-888888888888',
      memberId: MEMBER_ID,
      participantMemberIds: [MEMBER_ID, otherMemberId],
    }
    const item = { fromMemberId: MEMBER_ID, toMemberId: otherMemberId, playerId: PLAYER_ID }

    const oversizedItems = await handleApiRoute(authedRequest('POST', '/trades/propose-multi', {
      ...baseBody,
      items: Array.from({ length: 101 }, () => item),
    }))
    const oversizedItemsBody = await oversizedItems.json()
    if (oversizedItems.status !== 400 || oversizedItemsBody.error !== 'A trade cannot include more than 100 items.') {
      throw new Error(`expected trade item cap rejection, got ${oversizedItems.status}: ${JSON.stringify(oversizedItemsBody)}`)
    }

    const participantMemberIds = Array.from(
      { length: 13 },
      (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, '0')}`,
    )
    const oversizedParticipants = await handleApiRoute(authedRequest('POST', '/trades/propose-multi', {
      ...baseBody,
      participantMemberIds,
      items: [item],
    }))
    const oversizedParticipantsBody = await oversizedParticipants.json()
    if (oversizedParticipants.status !== 400 || oversizedParticipantsBody.error !== 'A trade cannot include more than 12 teams.') {
      throw new Error(`expected trade participant cap rejection, got ${oversizedParticipants.status}: ${JSON.stringify(oversizedParticipantsBody)}`)
    }

    for (const [field, value, expected] of [
      ['notes', 'x'.repeat(2001), 'notes must contain at most 2000 characters'],
      ['offerFaabAmount', 1_000_001, 'offerFaabAmount must be at most 1000000'],
    ] as const) {
      const response = await handleApiRoute(authedRequest('POST', '/trades/propose', {
        leagueId: LEAGUE_ID,
        leagueSeasonId: baseBody.leagueSeasonId,
        memberId: MEMBER_ID,
        recipientMemberId: otherMemberId,
        offerPlayerIds: [PLAYER_ID],
        requestPlayerIds: [PLAYER_ID],
        [field]: value,
      }))
      const responseBody = await response.json()
      if (response.status !== 400 || responseBody.error !== expected) {
        throw new Error(`expected ${field} cap rejection, got ${response.status}: ${JSON.stringify(responseBody)}`)
      }
    }

    const oversizedBody = await handleApiRoute(authedRequest('POST', '/trades/propose', {
      padding: 'x'.repeat(70_000),
    }))
    const oversizedBodyJson = await oversizedBody.json()
    if (oversizedBody.status !== 400 || oversizedBodyJson.error !== 'Request body must not exceed 64 KB') {
      throw new Error(`expected request byte cap rejection, got ${oversizedBody.status}: ${JSON.stringify(oversizedBodyJson)}`)
    }
  },
})

Deno.test({
  name: 'push token registration transfers one device between account owners',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    profileMutations.length = 0
    authenticatedUserId = USER_ID
    const first = await handleApiRoute(authedRequest('POST', '/profile/push-token', {
      token: 'ExponentPushToken[test-device]',
      active: true,
    }))
    authenticatedUserId = OTHER_USER_ID
    const second = await handleApiRoute(authedRequest('POST', '/profile/push-token', {
      token: 'ExponentPushToken[test-device]',
      active: true,
    }))
    authenticatedUserId = USER_ID

    if (first.status !== 200 || second.status !== 200) {
      throw new Error(`expected successful push transfer, got ${first.status}/${second.status}`)
    }
    const secondClear = profileMutations[2]
    const secondSet = profileMutations[3]
    if (!secondClear?.query.includes('push_token=eq.ExponentPushToken%5Btest-device%5D') ||
        !secondClear.query.includes(`id=neq.${OTHER_USER_ID}`) ||
        JSON.stringify(secondClear.body) !== JSON.stringify({ push_token: null })) {
      throw new Error(`second owner did not clear the prior token owner: ${JSON.stringify(secondClear)}`)
    }
    if (!secondSet?.query.includes(`id=eq.${OTHER_USER_ID}`) ||
        JSON.stringify(secondSet.body) !== JSON.stringify({ push_token: 'ExponentPushToken[test-device]' })) {
      throw new Error(`second owner did not receive the token: ${JSON.stringify(secondSet)}`)
    }
  },
})

Deno.test({
  name: 'push token unregister only clears the requesting owner when the device token still matches',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    profileMutations.length = 0
    authenticatedUserId = USER_ID
    const res = await handleApiRoute(authedRequest('POST', '/profile/push-token', {
      token: 'ExponentPushToken[test-device]',
      active: false,
    }))

    if (res.status !== 200 || profileMutations.length !== 1) {
      throw new Error(`expected one unregister mutation, got ${res.status}/${profileMutations.length}`)
    }
    const mutation = profileMutations[0]
    if (!mutation.query.includes(`id=eq.${USER_ID}`) ||
        !mutation.query.includes('push_token=eq.ExponentPushToken%5Btest-device%5D')) {
      throw new Error(`unregister was not owner/token constrained: ${mutation.query}`)
    }
  },
})

Deno.test({
  name: 'ordinary commissioners can generate only their requested league schedule',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    Deno.env.delete('ADMIN_USER_IDS')
    commissionerRole = 'commissioner'
    postgrestRequests.length = 0

    const res = await handleApiRoute(authedRequest('POST', '/sync/matchups', {
      leagueId: LEAGUE_ID,
      force: true,
    }))

    if (res.status !== 200) throw new Error(`expected commissioner schedule request 200, got ${res.status}`)
    const seasonQuery = postgrestRequests.find((entry) => entry.includes('/rest/v1/league_seasons'))
    if (!seasonQuery?.includes(`league_id=eq.${LEAGUE_ID}`)) {
      throw new Error(`schedule query was not league-scoped: ${seasonQuery ?? 'missing'}`)
    }
  },
})

Deno.test({
  name: 'platform admins remain league-scoped and do not require league membership',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    Deno.env.set('ADMIN_USER_IDS', USER_ID)
    commissionerRole = null
    postgrestRequests.length = 0

    const res = await handleApiRoute(authedRequest('POST', '/sync/matchups', {
      leagueId: LEAGUE_ID,
      force: true,
    }))

    Deno.env.delete('ADMIN_USER_IDS')
    commissionerRole = 'commissioner'
    if (res.status !== 200) throw new Error(`expected platform-admin schedule request 200, got ${res.status}`)
    if (postgrestRequests.some((entry) => entry.includes('/rest/v1/league_members'))) {
      throw new Error('platform admin unexpectedly required league membership')
    }
    const seasonQuery = postgrestRequests.find((entry) => entry.includes('/rest/v1/league_seasons'))
    if (!seasonQuery?.includes(`league_id=eq.${LEAGUE_ID}`)) {
      throw new Error(`admin schedule query was not league-scoped: ${seasonQuery ?? 'missing'}`)
    }
  },
})

Deno.test({
  name: 'schedule generation rejects missing league scope',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    Deno.env.set('ADMIN_USER_IDS', USER_ID)
    postgrestRequests.length = 0
    const res = await handleApiRoute(authedRequest('POST', '/sync/matchups', { force: true }))
    Deno.env.delete('ADMIN_USER_IDS')
    const body = await res.json()

    if (res.status !== 400 || body.error !== 'leagueId is required') {
      throw new Error(`expected missing scope rejection, got ${res.status}: ${JSON.stringify(body)}`)
    }
    if (postgrestRequests.some((entry) => entry.includes('/rest/v1/league_seasons'))) {
      throw new Error('missing-scope request reached schedule generation')
    }
  },
})

Deno.test({
  name: 'close API router test server',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => postgrest.shutdown(),
})

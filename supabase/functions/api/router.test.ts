const USER_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_USER_ID = '99999999-9999-4999-8999-999999999999'
const MEMBER_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_MEMBER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DRAFT_ID = '44444444-4444-4444-8444-444444444444'
const PLAYER_ID = '55555555-5555-4555-8555-555555555555'
const LEAGUE_ID = '66666666-6666-4666-8666-666666666666'

const postgrestRequests: string[] = []
const pushRpcRequests: { path: string; body: unknown }[] = []
const legacyPushMutations: { query: string; body: unknown }[] = []
const optimizerRequests: { internalToken: string | null; body: unknown }[] = []
let commissionerRole: string | null = 'commissioner'
let authenticatedUserId = USER_ID
let pushStarted = false
let pushCredentialRpcMissing = false

const expo = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, () => {
  pushStarted = true
  return Response.json({ data: { status: 'ok', id: 'push-test' } })
})

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
    body = url.searchParams.has('role')
      ? commissionerRole ? [{ league_id: LEAGUE_ID }] : []
      : { league_id: LEAGUE_ID }
  } else if (url.pathname === '/rest/v1/drafts' && url.searchParams.get('select') === 'league_id') {
    body = { league_id: LEAGUE_ID }
  } else if (url.pathname === '/rest/v1/drafts' && url.searchParams.get('select') === 'id') {
    body = { id: DRAFT_ID }
  } else if (url.pathname === '/rest/v1/league_members' && url.searchParams.get('select') === 'id') {
    body = { id: authenticatedUserId === USER_ID ? MEMBER_ID : OTHER_MEMBER_ID }
  } else if (url.pathname === '/rest/v1/league_members' && url.searchParams.get('select') === 'user_id') {
    body = { user_id: OTHER_USER_ID }
  } else if (url.pathname === '/rest/v1/league_members' && url.searchParams.get('select') === 'role') {
    body = commissionerRole ? { role: commissionerRole } : null
  } else if (url.pathname === '/rest/v1/draft_orders' && url.searchParams.get('select') === 'member_id') {
    body = [{ member_id: MEMBER_ID }, { member_id: OTHER_MEMBER_ID }]
  } else if (url.pathname.startsWith('/rest/v1/rpc/') && url.pathname.includes('push_token')) {
    pushRpcRequests.push({ path: url.pathname, body: await req.json() })
    if (pushCredentialRpcMissing) {
      return Response.json({ code: 'PGRST202', message: 'Could not find the function' }, { status: 404 })
    }
    body = url.pathname.endsWith('/register_push_token_atomic') ? null : true
  } else if (url.pathname === '/rest/v1/profiles' && req.method === 'PATCH') {
    legacyPushMutations.push({ query: url.searchParams.toString(), body: await req.json() })
    body = []
  } else if (url.pathname === '/rest/v1/profiles' && url.searchParams.get('select') === 'push_token') {
    body = { push_token: 'ExponentPushToken[route-lifecycle]' }
  } else if (url.pathname === '/rest/v1/notification_preferences') {
    body = []
  } else if (url.pathname === '/functions/v1/lineup-optimizer') {
    optimizerRequests.push({
      internalToken: req.headers.get('x-internal-function-token'),
      body: await req.json(),
    })
    body = {
      ok: true,
      dates: 42,
      optimized: 40,
      skipped: 1,
      failed: 1,
      metadataUpdated: true,
      results: [
        { date: '2027-01-01', status: 'optimized' },
        { date: '2027-01-02', status: 'skipped', reason: 'outside_season' },
        { date: '2027-01-03', status: 'failed', reason: 'optimization_failed' },
      ],
    }
  } else if (url.pathname === '/rest/v1/rpc/propose_trade_atomic') {
    body = UUID
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
Deno.env.set('PANCAKE_EDGE_INTERNAL_TOKEN', 'edge-internal-test')
Deno.env.set('EXPO_PUSH_URL', `http://127.0.0.1:${(expo.addr as Deno.NetAddr).port}`)

const { handleApiRoute } = await import('./router.ts')
const { assertUuid } = await import('../_shared/apiRuntime.ts')
const { EDGE_ARTIFACT_DIGEST, RELEASE_COMMIT_SHA } = await import('../_shared/releaseMetadata.ts')

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
    for (const action of ['presence-claim', 'resolve-presence']) {
      const removed = await handleApiRoute(authedRequest('POST', `/draft/${DRAFT_ID}/${action}`, {
        claims: ['replayed-public-channel-claim'],
      }))
      if (removed.status !== 404) throw new Error(`removed presence authority route ${action} returned ${removed.status}`)
    }

    const res = await handleApiRoute(request('GET', '/health'))
    const body = await res.json()

    if (res.status !== 200 || body.runtime !== 'supabase-edge' ||
      body.commitSha !== RELEASE_COMMIT_SHA || body.edgeArtifactDigest !== EDGE_ARTIFACT_DIGEST) {
      throw new Error(`expected health 200, got ${res.status}: ${JSON.stringify(body)}`)
    }
  },
})

Deno.test({
  name: 'concurrent push registrations fail closed while credential RPCs are not deployed',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    pushRpcRequests.length = 0
    legacyPushMutations.length = 0
    pushCredentialRpcMissing = true
    try {
      const responses = await Promise.all(['a', 'b'].map((suffix) =>
        handleApiRoute(authedRequest('POST', '/profile/push-token', {
          token: `ExponentPushToken[rolling-deploy-${suffix}]`,
          active: true,
        }))))
      const bodies = await Promise.all(responses.map((response) => response.json()))
      if (responses.some((response) => response.status !== 503) ||
          bodies.some((body) => body.ok !== false) || legacyPushMutations.length !== 0) {
        throw new Error(`pre-schema push registration did not fail closed: ${JSON.stringify({
          statuses: responses.map((response) => response.status),
          bodies,
          legacyPushMutations,
        })}`)
      }
    } finally {
      pushCredentialRpcMissing = false
    }
  },
})

Deno.test({
  name: 'rest-of-season lineup optimization is ownership-scoped and invokes one bounded server job',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    optimizerRequests.length = 0
    const response = await handleApiRoute(authedRequest('POST', '/league/lineup/auto-set-season', {
      memberId: MEMBER_ID,
      leagueId: LEAGUE_ID,
      leagueSeasonId: '88888888-8888-4888-8888-888888888888',
    }))
    const body = await response.json()
    if (response.status !== 200 || body.optimized !== 40 || body.failed !== 1 ||
        body.results?.[2]?.status !== 'failed' || optimizerRequests.length !== 1) {
      throw new Error(`expected one optimizer job, got ${response.status}: ${JSON.stringify(body)} ${JSON.stringify(optimizerRequests)}`)
    }
    if (optimizerRequests[0].internalToken !== 'edge-internal-test' ||
        JSON.stringify(optimizerRequests[0].body) !== JSON.stringify({
          mode: 'rest_of_season',
          memberId: MEMBER_ID,
          leagueId: LEAGUE_ID,
          leagueSeasonId: '88888888-8888-4888-8888-888888888888',
        })) {
      throw new Error(`optimizer request was not scoped/authenticated: ${JSON.stringify(optimizerRequests[0])}`)
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
      ['POST', '/profile/push-token/revoke'],
      ['POST', '/league/roster/ir'],
      ['POST', '/league/roster/taxi'],
      ['POST', '/league/lineup/auto-set-season'],
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
      ['POST', `/draft/${UUID}/pause-for-absence`],
      ['POST', `/draft/${UUID}/resume-if-absent`],
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
  name: 'auction absence lifecycle rejects participant claims and requires commissioner authority',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    commissionerRole = null
    for (const action of ['pause-for-absence', 'resume-if-absent']) {
      postgrestRequests.length = 0
      const response = await handleApiRoute(authedRequest('POST', `/draft/${DRAFT_ID}/${action}`, {
        claims: ['replayed-public-channel-claim'],
      }))
      const lifecycleRpcs = postgrestRequests.filter((entry) => entry.includes(`/rpc/${action.startsWith('pause') ? 'pause' : 'resume'}_draft_`))
      if (response.status !== 404 || lifecycleRpcs.length !== 0) {
        throw new Error(`ordinary member reached ${action}: ${response.status} ${JSON.stringify(lifecycleRpcs)}`)
      }
    }
    commissionerRole = 'commissioner'

    for (const action of ['pause-for-absence', 'resume-if-absent']) {
      postgrestRequests.length = 0
      const response = await handleApiRoute(authedRequest('POST', `/draft/${DRAFT_ID}/${action}`))
      const rpcName = action.startsWith('pause') ? 'pause_draft_for_absence_atomic' : 'resume_draft_if_absent_atomic'
      if (response.status !== 200 || !postgrestRequests.some((entry) => entry.includes(`/rpc/${rpcName}`))) {
        throw new Error(`commissioner could not ${action}: ${response.status} ${JSON.stringify(postgrestRequests)}`)
      }
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
    const thirdMemberId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const baseBody = {
      leagueId: LEAGUE_ID,
      leagueSeasonId: '88888888-8888-4888-8888-888888888888',
      memberId: MEMBER_ID,
      participantMemberIds: [MEMBER_ID, otherMemberId, thirdMemberId],
    }
    const item = { fromMemberId: MEMBER_ID, toMemberId: otherMemberId, playerId: PLAYER_ID }

    const undersizedParticipants = await handleApiRoute(authedRequest('POST', '/trades/propose-multi', {
      ...baseBody,
      participantMemberIds: [MEMBER_ID, otherMemberId],
      items: [item],
    }))
    const undersizedParticipantsBody = await undersizedParticipants.json()
    if (undersizedParticipants.status !== 400 || undersizedParticipantsBody.error !== 'A multi-team trade requires at least 3 teams.') {
      throw new Error(`expected trade participant minimum rejection, got ${undersizedParticipants.status}: ${JSON.stringify(undersizedParticipantsBody)}`)
    }

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
  name: 'trade routes leave notification delivery to the transactional outbox',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    pushStarted = false
    const response = await handleApiRoute(authedRequest('POST', '/trades/propose', {
      leagueId: LEAGUE_ID,
      leagueSeasonId: '88888888-8888-4888-8888-888888888888',
      memberId: MEMBER_ID,
      recipientMemberId: OTHER_MEMBER_ID,
      offerPlayerIds: [PLAYER_ID],
    }))
    if (response.status !== 200) throw new Error(`expected successful trade proposal, got ${response.status}`)
    if (pushStarted) throw new Error('trade route bypassed the transactional notification outbox')
  },
})

Deno.test({
  name: 'push token registration rotates a hashed per-device revocation credential',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    pushRpcRequests.length = 0
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
    const firstBody = await first.json()
    const secondBody = await second.json()
    authenticatedUserId = USER_ID

    if (first.status !== 200 || second.status !== 200 ||
        !/^[A-Za-z0-9_-]{43}$/.test(firstBody.revocationCredential) ||
        !/^[A-Za-z0-9_-]{43}$/.test(secondBody.revocationCredential) ||
        firstBody.revocationCredential === secondBody.revocationCredential) {
      throw new Error(`expected successful push transfer, got ${first.status}/${second.status}`)
    }
    const registrations = pushRpcRequests.filter((entry) => entry.path.endsWith('/register_push_token_atomic'))
    if (registrations.length !== 2 || registrations.some((entry) => {
      const body = entry.body as { p_token?: string; p_revocation_hash?: string }
      return body.p_token !== 'ExponentPushToken[test-device]' || !/^[0-9a-f]{64}$/.test(body.p_revocation_hash ?? '')
    })) {
      throw new Error(`registration was not atomic/hashed: ${JSON.stringify(registrations)}`)
    }

    const revoke = await handleApiRoute(request('POST', '/profile/push-token/revoke', {
      token: 'ExponentPushToken[test-device]',
      revocationCredential: secondBody.revocationCredential,
    }))
    const revocations = pushRpcRequests.filter((entry) => entry.path.endsWith('/revoke_push_token_atomic'))
    if (revoke.status !== 200 || revocations.length !== 1 ||
        (revocations[0].body as { p_revocation_hash?: string }).p_revocation_hash !==
          (registrations[1].body as { p_revocation_hash?: string }).p_revocation_hash) {
      throw new Error(`sessionless revocation did not use the current credential: ${JSON.stringify(revocations)}`)
    }
  },
})

Deno.test({
  name: 'push token unregister only clears the requesting owner when the device token still matches',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    pushRpcRequests.length = 0
    authenticatedUserId = USER_ID
    const res = await handleApiRoute(authedRequest('POST', '/profile/push-token', {
      token: 'ExponentPushToken[test-device]',
      active: false,
    }))

    if (res.status !== 200 || pushRpcRequests.length !== 1) {
      throw new Error(`expected one unregister mutation, got ${res.status}/${pushRpcRequests.length}`)
    }
    const mutation = pushRpcRequests[0]
    const mutationBody = mutation.body as { p_user_id?: string; p_token?: string }
    if (!mutation.path.endsWith('/clear_push_token_for_user_atomic') ||
        mutationBody.p_user_id !== USER_ID || mutationBody.p_token !== 'ExponentPushToken[test-device]') {
      throw new Error(`unregister was not owner/token constrained: ${JSON.stringify(mutation)}`)
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
  name: 'non-commissioners cannot generate a league schedule',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    Deno.env.delete('ADMIN_USER_IDS')
    commissionerRole = 'member'
    postgrestRequests.length = 0
    const res = await handleApiRoute(authedRequest('POST', '/sync/matchups', {
      leagueId: LEAGUE_ID,
      force: true,
    }))
    commissionerRole = 'commissioner'
    const body = await res.json()

    if (res.status !== 403 || body.error !== 'Commissioner access required') {
      throw new Error(`expected non-commissioner rejection, got ${res.status}: ${JSON.stringify(body)}`)
    }
    if (postgrestRequests.some((entry) => entry.includes('/rest/v1/league_seasons'))) {
      throw new Error('non-commissioner request reached schedule generation')
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
  fn: () => {
    postgrest.shutdown()
    expo.shutdown()
  },
})

const league = '10000000-0000-4000-8000-000000000001'
const user = '10000000-0000-4000-8000-000000000002'
const bodies: Record<string, unknown>[] = []
let denied = false
const backend = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async request => {
  const path = new URL(request.url).pathname
  if (path === '/auth/v1/user') return Response.json({ id: user })
  if (path !== '/rest/v1/rpc/get_league_version') return Response.json({ error: path }, { status: 500 })
  bodies.push(await request.json())
  return denied
    ? Response.json({ code: '42501', message: 'League not found' }, { status: 403 })
    : Response.json({ version: '9007199254740993', changes: [] })
})
Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(backend.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_local_version_test')
const { handleApiRoute } = await import('../router.ts')
function request(query: string, authenticated = true) {
  return new Request(`http://127.0.0.1/functions/v1/api/version?${query}`, {
    headers: authenticated ? { Authorization: 'Bearer local-version-test' } : {},
  })
}
function check(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label)
}
Deno.test({
  name: 'version route preserves exact counters, validates inputs, and enforces membership',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    try {
      const response = await handleApiRoute(request(`league=${league}&since=9007199254740993`))
      check(response.status === 200, 'mounted route succeeds')
      check(response.headers.get('cache-control') === 'private, no-store', 'private responses never cache')
      check(JSON.stringify(await response.json()) === JSON.stringify({ version: '9007199254740993', changes: [] }), 'response stays tiny')
      check(JSON.stringify(bodies[0]) === JSON.stringify({ p_league_id: league, p_user_id: user, p_since: '9007199254740993' }), 'RPC receives an exact bigint and authenticated identity')
      for (const query of ['league=bad', `league=${league}&since=-1`, `league=${league}&since=1.5`, `league=${league}&since=9223372036854775808`, `league=${league}&since=01`]) {
        const invalid = await handleApiRoute(request(query))
        check(invalid.status === 400, `invalid query rejected: ${query}`)
        await invalid.body?.cancel()
      }
      const unauthenticated = await handleApiRoute(request(`league=${league}`, false))
      check(unauthenticated.status === 401, 'authentication required')
      await unauthenticated.body?.cancel()
      check(bodies.length === 1, 'invalid and unauthenticated calls perform no database reads')
      denied = true
      const forbidden = await handleApiRoute(request(`league=${league}`))
      check(forbidden.status === 403, 'membership denial survives routing')
      await forbidden.body?.cancel()
    } finally {
      await backend.shutdown()
    }
  },
})

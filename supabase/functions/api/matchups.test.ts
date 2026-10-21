const calls: { name: string; body: Record<string, unknown> }[] = []
let fail = false
const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async req => {
  const url = new URL(req.url)
  if (url.pathname.endsWith('/league_members')) return Response.json(url.searchParams.get('league_id') === 'eq.solo' ? [{ id: 'one' }] : [{ id: 'one' }, { id: 'two' }])
  if (req.method === 'POST') {
    calls.push({ name: url.pathname.split('/').at(-1)!, body: await req.json() })
    return new Response(JSON.stringify(fail ? { message: 'schedule unavailable' } : {}), { status: fail ? 400 : 200, headers: { 'content-type': 'application/json' } })
  }
  return new Response(JSON.stringify([
    { id: 'season-a', league_id: 'league-a', leagues: { playoff_start_week: 15 } },
    { id: 'season-b', league_id: 'league-b', leagues: null },
  ]), { headers: { 'content-type': 'application/json' } })
})
Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
const { generateMatchups, generateAllMatchups } = await import('./matchups.ts')
function assert(value: boolean): void { if (!value) throw new Error('Schedule delegation failed') }
Deno.test({ name: 'SQL owns schedule order and saved settings', sanitizeOps: false, sanitizeResources: false, fn: async () => {
  await generateMatchups('league-a', 'season-a', 19, true)
  assert(calls[0].name === 'replace_regular_season_matchups_atomic')
  assert(JSON.stringify(calls[0].body) === JSON.stringify({ p_league_id: 'league-a', p_league_season_id: 'season-a', p_force: true }))
  calls.length = 0
  await generateAllMatchups()
  assert(calls.length === 2 && calls.every(call => call.body.p_force === false && !('p_matchups' in call.body)))
  await generateMatchups('solo', 'season-solo', 19)
  assert(calls.length === 2)
  fail = true
  let rejected = false
  try { await generateMatchups('league-a', 'season-a', 19) } catch { rejected = true }
  assert(rejected)
  await server.shutdown()
} })

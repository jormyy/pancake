import { strict as assert } from 'node:assert'
import { createClient } from 'npm:@supabase/supabase-js@2.98.0'
import type { Database } from '../../../types/database.ts'

const api = Deno.env.get('SUPABASE_URL')!
const db = Deno.env.get('SUPABASE_DB_URL')!
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(api).hostname))
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
const key = Deno.env.get('PANCAKE_SUPABASE_SECRET_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY')
const publicKey = Deno.env.get('E2E_SUPABASE_PUBLISHABLE_KEY')!
assert.ok(key && publicKey)
const admin = createClient<Database>(api, key, { auth: { persistSession: false, autoRefreshToken: false } })
const scope = crypto.randomUUID().replaceAll('-', '')
const league = crypto.randomUUID(), season = crypto.randomUUID(), draft = crypto.randomUUID()
const members = Array.from({ length: 3 }, () => crypto.randomUUID())
const users: string[] = []
const clients: ReturnType<typeof createClient<Database>>[] = []
const tokens: string[] = []
const password = `Synthetic-${crypto.randomUUID()}!`
async function query<T>(operation: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}
async function sql(command: string) {
  const result = await new Deno.Command('psql', { args: [db, '-XqAt', '--set', 'ON_ERROR_STOP=1', '-c', command], stdin: 'null', stdout: 'piped', stderr: 'piped' }).output()
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}
async function activate(side?: number, body = {}) {
  const response = await fetch(`${api}/functions/v1/api/draft/${draft}/activate-rookie-league`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(side === undefined ? {} : { Authorization: `Bearer ${tokens[side]}` }) }, body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}
async function reset() { await query(admin.from('leagues').update({ status: 'drafting' }).eq('id', league)) }
async function status() { return (await query(admin.from('leagues').select('status').eq('id', league).single()))?.status }
try {
  for (let side = 0; side < 4; side++) {
    const email = `rookie-actor-${scope}-${side}@example.test`
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true,
      user_metadata: { username: `actor_${scope.slice(0, 14)}_${side}` } })
    if (error) throw error
    assert.ok(data.user); users.push(data.user.id)
    const client = createClient<Database>(api, publicKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const login = await client.auth.signInWithPassword({ email, password })
    if (login.error) throw login.error
    assert.ok(login.data.session); tokens.push(login.data.session.access_token); clients.push(client)
  }
  await query(admin.from('leagues').insert({ id: league, name: 'Owned rookie activation actor', slug: scope, commissioner_id: users[0], status: 'drafting' }))
  await query(admin.from('league_members').insert(members.map((id, side) => ({ id, league_id: league, user_id: users[side], role: (['commissioner', 'co_commissioner', 'manager'] as const)[side], team_name: `Actor ${side}` }))))
  await query(admin.from('league_seasons').insert({ id: season, league_id: league, season_year: 39999, is_current: true }))
  await query(admin.from('drafts').insert({ id: draft, league_id: league, league_season_id: season, draft_type: 'snake', status: 'completed', is_mock: false, rounds: 1 }))
  await query(admin.from('snake_draft_picks').insert(members.map((member_id, index) => ({ draft_id: draft, member_id,
    overall_pick: index + 1, round: 1, pick_in_round: index + 1, skipped_at: new Date().toISOString(), skip_reason: 'No eligible players' }))))
  for (const side of [undefined, 3]) {
    const result = await activate(side, { userId: users[0], actorUserId: users[0] })
    assert.equal(result.status, side === undefined ? 401 : 404, JSON.stringify(result))
    assert.equal(await status(), 'drafting')
  }
  for (const side of [0, 1, 2]) {
    const result = await activate(side)
    assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.body.activated, true)
    assert.equal(await status(), 'active'); await reset()
  }
  console.log(JSON.stringify({ case: 'real Edge API permits every league member and denies anonymous users and outsiders', denied: 2, authorized: 3 }))

  for (const side of [2, 3]) {
    const denied = await clients[side].rpc('activate_rookie_draft_league_atomic', { p_draft_id: draft })
    assert.equal(denied.error?.code, '42501')
    const forged = await clients[side].rpc('activate_rookie_draft_league_for_user_atomic', { p_draft_id: draft, p_user_id: users[0] })
    assert.equal(forged.error?.code, '42501')
  }
  const manager = await admin.rpc('activate_rookie_draft_league_for_user_atomic', { p_draft_id: draft, p_user_id: users[2] })
  assert.equal(manager.error, null); assert.equal(manager.data, true); assert.equal(await status(), 'active')
  await reset()
  assert.equal(await query(clients[0].rpc('activate_rookie_draft_league_atomic', { p_draft_id: draft })), true)
  await reset()
  await sql(`BEGIN; SET LOCAL ROLE service_role; DO $$ BEGIN
    BEGIN PERFORM public.activate_rookie_draft_league_for_user_atomic('${draft}',NULL); RAISE EXCEPTION 'Missing actor activates'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    END $$; ROLLBACK`)
  await sql(`BEGIN; SET LOCAL ROLE anon; DO $$ BEGIN
    BEGIN PERFORM public.activate_rookie_draft_league_for_user_atomic('${draft}','${users[0]}'); RAISE EXCEPTION 'Anonymous actor activates'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    END $$; ROLLBACK`)
  console.log(JSON.stringify({ case: 'actual database roles deny forged and missing actors while legacy commissioner RPC stays valid', denied: 6 }))

  const gateName = `rookie-role-${scope}`
  const gate = new Deno.Command('psql', { args: [db, '-XqAt', '--set', 'ON_ERROR_STOP=1', '-c',
    `SET application_name='${gateName}'; BEGIN; SELECT id FROM leagues WHERE id='${league}' FOR UPDATE;
    UPDATE league_members SET role='manager' WHERE id='${members[0]}'; SELECT pg_sleep(3); COMMIT`], stdin: 'null', stdout: 'piped', stderr: 'piped' }).spawn()
  let sleeping = false
  for (let poll = 0; poll < 100; poll++) {
    if (await sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${gateName}' AND wait_event='PgSleep'`) === '1') { sleeping = true; break }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(sleeping)
  const pending = activate(0)
  let blocked = false
  for (let poll = 0; poll < 100; poll++) {
    if (Number(await sql("SELECT count(*) FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%activate_rookie_draft_league_for_user_atomic%'")) > 0) { blocked = true; break }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const stale = await pending, gateResult = await gate.output()
  assert.equal(gateResult.code, 0, new TextDecoder().decode(gateResult.stderr))
  assert.ok(blocked, 'The actual API must reach atomic membership authorization after its precheck')
  assert.equal(stale.status, 200, JSON.stringify(stale)); assert.equal(stale.body.activated, true)
  assert.equal(await status(), 'active')
  await reset()
  console.log(JSON.stringify({ case: 'concurrent demotion retains league membership and can still activate', lockOverlap: blocked, status: stale.status }))
  await query(admin.from('league_members').update({ role: 'commissioner' }).eq('id', members[0]))
  await query(admin.from('league_seasons').update({ is_current: false }).eq('id', season))
  assert.equal(await query(admin.rpc('activate_rookie_draft_league_for_user_atomic', { p_draft_id: draft, p_user_id: users[0] })), false)
  assert.equal(await status(), 'drafting')
} finally {
  await query(admin.from('snake_draft_picks').delete().eq('draft_id', draft))
  await query(admin.from('drafts').delete().eq('id', draft))
  await query(admin.from('leagues').delete().eq('id', league))
  for (const id of users) { const { error } = await admin.auth.admin.deleteUser(id); if (error) throw error }
  console.log(JSON.stringify({ cleanup: 'owned activation fixture and users removed' }))
}

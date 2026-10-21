import { strict as assert } from 'node:assert'
import { createClient } from 'npm:@supabase/supabase-js@2.98.0'
import type { Database } from '../../../types/database.ts'

const api = Deno.env.get('SUPABASE_URL')!
const db = Deno.env.get('SUPABASE_DB_URL')!
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(api).hostname) && new URL(api).port === '57821')
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(db).hostname) && new URL(db).port === '57822')
const key = Deno.env.get('PANCAKE_SUPABASE_SECRET_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY')
assert.ok(key)
const internalToken = Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')!
assert.ok(internalToken)
const admin = createClient<Database>(api, key, { auth: { persistSession: false, autoRefreshToken: false } })
const users = [crypto.randomUUID(), crypto.randomUUID()]
const members = [crypto.randomUUID(), crypto.randomUUID()]
const league = crypto.randomUUID(), season = crypto.randomUUID()
const matchups = Array.from({ length: 3 }, () => crypto.randomUUID())
const scope = crypto.randomUUID().replaceAll('-', '')
const homeToken = `ExponentPushToken[${scope}]`
let year = 0, providerFails = true
const sends: { to: string; title: string; body: string; data: { matchupId: string } }[] = []
const tickets: string[] = []
const provider = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async request => {
  const path = new URL(request.url).pathname
  const body = await request.json()
  if (path === '/receipts') {
    assert.ok(body.ids.every((id: string) => tickets.includes(id)))
    return Response.json({ data: Object.fromEntries(body.ids.map((id: string) => [id, { status: 'ok' }])) })
  }
  assert.equal(path, '/send')
  sends.push(...body)
  if (providerFails) return Response.json({ error: 'Owned push outage' }, { status: 503 })
  const data = body.map(() => { const id = crypto.randomUUID(); tickets.push(id); return { status: 'ok', id } })
  return Response.json({ data })
})
Deno.env.set('EXPO_PUSH_URL', `http://127.0.0.1:${provider.addr.port}/send`)
Deno.env.set('EXPO_RECEIPTS_URL', `http://127.0.0.1:${provider.addr.port}/receipts`)
Deno.env.set('EXPO_RECEIPT_DELAY_SECONDS', '0')
const nativeServe = Deno.serve
const descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
let worker: Deno.HttpServer<Deno.NetAddr> | undefined
Object.defineProperty(Deno, 'serve', { value: (handler: Deno.ServeHandler) => {
  worker = nativeServe({ hostname: '127.0.0.1', port: 0, onListen() {} }, handler)
  return worker
} })
try { await import('../../functions/process-trades/index.ts') } finally { Object.defineProperty(Deno, 'serve', descriptor) }
assert.ok(worker)
const endpoint = `http://127.0.0.1:${worker.addr.port}`
const nativeFetch = globalThis.fetch.bind(globalThis)
const localOrigins = new Set([new URL(api).origin, `http://127.0.0.1:${provider.addr.port}`, endpoint])
globalThis.fetch = (input, init) => {
  assert.ok(localOrigins.has(new URL(input instanceof Request ? input.url : input).origin), 'Only owned local services receive requests')
  return nativeFetch(input, init)
}
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
async function rows() {
  return await query(admin.from('notification_outbox').select('*').in('member_id', members).eq('event_type', 'matchup_final').order('dedupe_key'))
}
async function payload(index: number) {
  const token = await query(admin.rpc('capture_score_inputs', { p_league_season_id: season, p_week_number: index + 1 }))
  return { p_league_id: league, p_league_season_id: season, p_week_number: index + 1,
    p_matchups: [{ id: matchups[index], input_token: token, home_points: 10, away_points: index ? 5 : 10,
      winner_member_id: index ? members[0] : null }], p_standings: [] }
}
async function drain() {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'x-internal-function-token': internalToken } })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  return result
}
try {
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = 20000 + crypto.getRandomValues(new Uint32Array(1))[0] % 100000
    if (!(await query(admin.from('season_weeks').select('id').eq('season_year', candidate)))?.length) { year = candidate; break }
  }
  assert.ok(year)
  await sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) SELECT id,id::text||'@example.test',jsonb_build_object('username',id::text) FROM unnest(ARRAY[${users.map(id => `'${id}'::uuid`).join(',')}]) id`)
  await query(admin.from('leagues').insert({ id: league, slug: scope, name: 'Owned final notifications', commissioner_id: users[0], status: 'active' }))
  await query(admin.from('league_members').insert(members.map((id, side) => ({ id, league_id: league, user_id: users[side], role: side ? 'manager' as const : 'commissioner' as const, team_name: `Final ${side}` }))))
  await query(admin.from('league_seasons').insert({ id: season, league_id: league, season_year: year, is_current: true }))
  await query(admin.from('season_weeks').insert([1, 2, 3, 4].map(week => ({ season_year: year, week_number: week,
    week_start: `2020-10-${String(week * 7).padStart(2, '0')}`, week_end: week === 4 ? '2020-11-03' : `2020-10-${String(week * 7 + 6).padStart(2, '0')}` }))))
  await query(admin.from('matchups').insert(matchups.map((id, index) => ({ id, league_id: league, league_season_id: season,
    week_number: index + 1, end_week_number: index === 2 ? 4 : null, home_member_id: members[0], away_member_id: members[1],
    matchup_type: index === 2 ? 'playoff_final' as const : 'regular_season' as const }))))
  await query(admin.from('profiles').update({ push_token: homeToken }).eq('id', users[0]))
  await query(admin.from('profiles').update({ push_token: `ExponentPushToken[away-${scope}]` }).eq('id', users[1]))
  await query(admin.from('notification_preferences').upsert(users.map((user_id, side) => ({ user_id, activity_enabled: !side, trade_enabled: !!side }))))
  const final = await payload(0)
  const gateName = `final-gate-${scope}`
  const gate = new Deno.Command('psql', { args: [db, '-XqAt', '--set', 'ON_ERROR_STOP=1', '-c',
    `SET application_name='${gateName}'; BEGIN; SELECT id FROM leagues WHERE id='${league}' FOR UPDATE; SELECT pg_sleep(3); COMMIT`], stdin: 'null', stdout: 'piped', stderr: 'piped' }).spawn()
  let sleeping = false
  for (let poll = 0; poll < 100; poll++) {
    if (await sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${gateName}' AND wait_event='PgSleep'`) === '1') { sleeping = true; break }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(sleeping)
  const first = admin.rpc('finalize_score_week_atomic', final).then(value => value)
  const second = admin.rpc('finalize_score_week_atomic', final).then(value => value)
  let blocked = false
  for (let poll = 0; poll < 100; poll++) {
    if (Number(await sql(`SELECT count(*) FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%finalize_score_week_atomic%'`)) >= 2) { blocked = true; break }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const outcomes = await Promise.all([first, second]); const gateResult = await gate.output()
  assert.equal(gateResult.code, 0, new TextDecoder().decode(gateResult.stderr)); assert.ok(blocked, 'Both real finalizations must overlap at the league lock')
  assert.equal(outcomes.filter(outcome => outcome.error === null).length, 1)
  assert.equal(outcomes.filter(outcome => outcome.error?.code === 'PT409').length, 1)
  assert.deepEqual(outcomes.find(outcome => outcome.error === null)?.data, [], 'Durable alerts must leave no inline delivery work for older workers')
  await query(admin.rpc('finalize_score_week_atomic', await payload(0)))
  let queued = await rows(); assert.equal(queued?.length, 2)
  assert.ok(queued?.every(row => row.body === 'You tied 10.00–10.00.' && row.category === 'activity' && !row.delivered_at))
  assert.equal(sends.length, 0, 'Committing results cannot depend on inline network delivery')
  console.log(JSON.stringify({ case: 'overlapping finalizations commit one durable notification per recipient before delivery', queued: queued?.length, lockOverlap: blocked }))

  const failed = await payload(1)
  const rejected = await admin.rpc('finalize_score_week_atomic', { ...failed, p_standings: [{ member_id: crypto.randomUUID(), wins: 1, losses: 0, ties: 0, points_for: 10, points_against: 5, max_possible_points: 10, waiver_priority: 1 }] })
  assert.ok(rejected.error)
  assert.equal((await query(admin.from('matchups').select('is_finalized').eq('id', matchups[1]).single()))?.is_finalized, false)
  assert.equal((await rows())?.length, 2, 'A failure after enqueue must roll back both result and notifications')
  await query(admin.rpc('finalize_score_week_atomic', await payload(1)))
  await query(admin.rpc('finalize_score_week_atomic', await payload(2)))
  const replay = await payload(0)
  await query(admin.rpc('finalize_score_week_atomic', { ...replay, p_matchups: [{ ...replay.p_matchups[0], away_points: 11, winner_member_id: members[1] }] }))
  queued = await rows(); assert.equal(queued?.length, 6)
  const finalRows = queued?.filter(row => (row.data as { matchupId: string }).matchupId === matchups[2])
  assert.ok(finalRows?.every(row => row.title === 'Weeks 3–4 Final'))
  assert.deepEqual(finalRows?.map(row => row.body).sort(), ['You lost 5.00–10.00.', 'You won 10.00–5.00! 🏆'])
  assert.equal(sends.length, 0)
  console.log(JSON.stringify({ case: 'failure rolls back, later rounds retain labels, corrections do not notify again', durableRows: queued?.length }))

  await sql(`BEGIN; DO $$ DECLARE role_name text; BEGIN
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      EXECUTE format('SET LOCAL ROLE %I',role_name);
      BEGIN PERFORM public.claim_notification_outbox_atomic(); RAISE EXCEPTION 'Client claims private notifications'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
      BEGIN PERFORM count(*) FROM public.notification_outbox; RAISE EXCEPTION 'Client reads private notifications'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
      RESET ROLE;
    END LOOP;
  END $$; ROLLBACK`)

  assert.equal((await fetch(endpoint, { method: 'POST' })).status, 401)
  const outage = await drain()
  assert.equal(outage.notificationsDeferred, 3); assert.equal(outage.notificationsDiscarded, 0)
  queued = await rows()
  assert.equal(queued?.filter(row => row.attempt_count === 1 && row.last_error && !row.delivered_at).length, 3)
  assert.equal(queued?.filter(row => (row as unknown as { suppressed_at: string | null }).suppressed_at && !row.delivered_at).length, 3)
  assert.ok(sends.every(message => message.to === homeToken), 'Activity opt-outs apply independently of trade preferences')
  providerFails = false
  const beforeRetry = sends.length
  await new Promise(resolve => setTimeout(resolve, 1200))
  const deliveries = await Promise.all([drain(), drain()])
  assert.equal(deliveries.reduce((sum, result) => sum + result.notificationsTicketed, 0), 3)
  assert.equal(deliveries.reduce((sum, result) => sum + result.notificationsDelivered, 0), 3)
  queued = await rows(); assert.ok(queued?.every(row => (row.delivered_at || (row as unknown as { suppressed_at: string | null }).suppressed_at) && !row.claim_token && !row.expo_ticket_id))
  assert.equal(sends.length - beforeRetry, 3)
  assert.equal(new Set(sends.slice(beforeRetry).map(message => message.data.matchupId)).size, 3)
  const finalSendCount = sends.length
  await drain(); assert.equal(sends.length, finalSendCount)
  console.log(JSON.stringify({ case: 'outage retries once through concurrent workers and real receipts, opt-outs stay private', successfulPushes: 3, discarded: 3, replayPushes: 0 }))
} finally {
  await worker.shutdown(); await provider.shutdown()
  globalThis.fetch = nativeFetch
  await query(admin.from('leagues').delete().eq('id', league))
  if (year) await query(admin.from('season_weeks').delete().eq('season_year', year))
  await sql(`DELETE FROM auth.users WHERE id=ANY(ARRAY[${users.map(id => `'${id}'::uuid`).join(',')}])`)
  console.log(JSON.stringify({ cleanup: 'owned final-notification fixture and listeners removed' }))
}

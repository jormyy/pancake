import { strict as assert } from 'node:assert'
import { createClient } from 'npm:@supabase/supabase-js@2.98.0'

const api = Deno.env.get('SUPABASE_URL')!
const db = Deno.env.get('SUPABASE_DB_URL')!
const port = Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322'
assert.match(port, /^\d+$/)
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(db).hostname) && new URL(db).port === port)
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(api).hostname) && new URL(api).port === String(Number(port) - 1))
const secret = Deno.env.get('PANCAKE_SUPABASE_SECRET_KEY')!
const publicKey = Deno.env.get('PANCAKE_SUPABASE_PUBLISHABLE_KEY')!
assert.ok(secret && publicKey)
const admin = createClient(api, secret, { auth: { persistSession: false, autoRefreshToken: false } })
const users: string[] = []
const sessions: string[] = []
const members: string[] = [crypto.randomUUID(), crypto.randomUUID()]
const league = crypto.randomUUID(), season = crypto.randomUUID()
const players = Array.from({ length: 4 }, () => crypto.randomUUID())
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
async function sql(statement: string) {
  const result = await new Deno.Command('psql', { args: [db, '-XqAtv', 'ON_ERROR_STOP=1', '-c', statement], stdout: 'piped', stderr: 'piped' }).output()
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}
const pushes: { data: { pickId: string; notificationEvent: string } }[] = []
let worker: Deno.HttpServer<Deno.NetAddr> | undefined
const internalToken = Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')!
assert.ok(internalToken)
const fake = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async request => {
  const body = await request.json()
  if (new URL(request.url).pathname === '/receipts') {
    return Response.json({ data: Object.fromEntries(body.ids.map((id: string) => [id, { status: 'ok' }])) })
  }
  pushes.push(...body)
  return Response.json({ data: body.map(() => ({ status: 'ok', id: crypto.randomUUID() })) })
})
Deno.env.set('EXPO_PUSH_URL', `http://127.0.0.1:${fake.addr.port}/send`)
Deno.env.set('EXPO_RECEIPTS_URL', `http://127.0.0.1:${fake.addr.port}/receipts`)
Deno.env.set('EXPO_RECEIPT_DELAY_SECONDS', '0')
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (input, init) => {
  const origin = new URL(input instanceof Request ? input.url : input).origin
  assert.ok([new URL(api).origin, `http://127.0.0.1:${fake.addr.port}`, worker ? `http://127.0.0.1:${worker.addr.port}` : ''].includes(origin), 'Only owned test services receive requests')
  return nativeFetch(input, init)
}
try {
  for (let i = 0; i < 2; i++) {
    const email = `${crypto.randomUUID()}@example.test`
    const password = crypto.randomUUID()
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    assert.equal(created.error, null)
    users.push(created.data.user!.id)
    const auth = createClient(api, publicKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const signed = await auth.auth.signInWithPassword({ email, password })
    assert.equal(signed.error, null)
    sessions.push(signed.data.session!.access_token)
  }
  await sql(`BEGIN;
    INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_entrants,playoff_round_lengths)
      VALUES(${quote(league)},'Synthetic API notifications',${quote(league)},${quote(users[0])},'offseason',2,ARRAY[1]);
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${quote(season)},${quote(league)},20070,true);
    ${members.map((id, i) => `INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${quote(id)},${quote(league)},${quote(users[i])},'${i ? 'manager' : 'commissioner'}','API ${i}');`).join('\n')}
    ${players.map((id, i) => `INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number) VALUES(${quote(id)},'Synthetic','API ${i}','PG',ARRAY['PG'],0,${i+1});`).join('\n')}
    INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
      SELECT y,w,date '2026-10-20'+(w-1)*7,date '2026-10-26'+(w-1)*7 FROM generate_series(20070,20071) y CROSS JOIN generate_series(1,24) w;
    INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
      SELECT ${quote(league)},20070,1,m,m FROM unnest(ARRAY[${members.map(quote).join(',')}]::uuid[]) m;
    UPDATE profiles SET push_token='ExponentPushToken[notif-api-'||id||']' WHERE id IN (${users.map(quote).join(',')});
    COMMIT;`)
  const { handleDraftRoute } = await import('../../functions/api/draft.ts')
  const nativeServe = Deno.serve
  const descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
  Object.defineProperty(Deno, 'serve', { value: (handler: Deno.ServeHandler) => {
    worker = nativeServe({ hostname: '127.0.0.1', port: 0, onListen() {} }, handler)
    return worker
  } })
  try { await import('../../functions/process-trades/index.ts') } finally { Object.defineProperty(Deno, 'serve', descriptor) }
  assert.ok(worker)
  const endpoint = `http://127.0.0.1:${worker.addr.port}`
  async function drain() {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'x-internal-function-token': internalToken } })
    assert.equal(response.status, 200, await response.text())
  }
  async function action(path: string, body: object, actor = 0) {
    const before = pushes.length
    const response = await handleDraftRoute(new Request(api + path, { method: 'POST',
      headers: { authorization: `Bearer ${sessions[actor]}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), path)
    assert.ok(response)
    const result = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result))
    assert.equal(pushes.length, before, 'API actions cannot send inline notifications')
    return result
  }
  for (let year = 20070; year <= 20071; year++) {
    await action('/draft/start-rookie', { leagueId: league, rounds: 1, pickTimerSeconds: 60, timerExpiryBehavior: 'auto_pick' })
    const draft = await sql(`SELECT id FROM drafts WHERE league_id=${quote(league)} AND league_season_id=(SELECT id FROM league_seasons WHERE league_id=${quote(league)} AND is_current)`)
    for (let pick = 1; pick <= 2; pick++) {
      const owner = await sql(`SELECT member_id FROM snake_draft_picks WHERE draft_id=${quote(draft)} AND overall_pick=${pick}`)
      const actor = members.indexOf(owner)
      await action(`/draft/${draft}/pause`, {})
      await action(`/draft/${draft}/resume`, {})
      await drain()
      await drain()
      const before = await sql(`SELECT count(*) FROM notification_outbox WHERE event_type='draft_on_clock' AND data->>'draftId'=${quote(draft)}`)
      await action(`/draft/${draft}/auto-pick`, { memberId: owner }, actor)
      if (pick === 1) {
        assert.equal(Number(await sql(`SELECT count(*) FROM notification_outbox WHERE event_type='draft_on_clock' AND data->>'draftId'=${quote(draft)}`)), Number(before)+1)
      }
    }
    assert.equal(await sql(`SELECT count(*) FROM notification_outbox WHERE event_type='draft_on_clock' AND data->>'draftId'=${quote(draft)}`), '2')
    assert.equal(await sql(`SELECT count(*) FROM snake_draft_picks p WHERE p.draft_id=${quote(draft)} AND
      (SELECT count(*) FROM notification_outbox o WHERE o.event_type='draft_on_clock' AND o.data->>'pickId'=p.id::text AND o.member_id=p.member_id)=1`), '2')
    const count = await sql(`SELECT count(*) FROM notification_outbox WHERE data->>'draftId'=${quote(draft)}`)
    await assert.rejects(() => action(`/draft/${draft}/auto-pick`, { memberId: members[0] }))
    assert.equal(await sql(`SELECT count(*) FROM notification_outbox WHERE data->>'draftId'=${quote(draft)}`), count)
    if (year === 20070) await sql(`UPDATE leagues SET status='archived' WHERE id=${quote(league)}; SELECT * FROM advance_season_atomic(${quote(league)});`)
  }
  assert.equal(pushes.length, 4)
  assert.equal(new Set(pushes.map(push => push.data.pickId)).size, 4)
  assert.ok(pushes.every(push => push.data.notificationEvent === 'draft_on_clock'))
  assert.equal(await sql(`SELECT count(*) FROM notification_outbox WHERE member_id IN (${members.map(quote).join(',')}) AND event_type='draft_on_clock' AND delivered_at IS NOT NULL`), '4')
  console.log('SYNTHETIC: two API drafts, four durable turn deliveries, correct owners, pause/resume, repeated drains, rejected retry, zero inline sends')
} finally {
  globalThis.fetch = nativeFetch
  await worker?.shutdown()
  await fake.shutdown()
  await sql(`DELETE FROM draft_orders WHERE draft_id IN (SELECT id FROM drafts WHERE league_id=${quote(league)}); DELETE FROM snake_draft_picks WHERE draft_id IN (SELECT id FROM drafts WHERE league_id=${quote(league)}); DELETE FROM draft_picks WHERE league_id=${quote(league)}; DELETE FROM drafts WHERE league_id=${quote(league)}; DELETE FROM leagues WHERE id=${quote(league)}; DELETE FROM players WHERE id IN (${players.map(quote).join(',')}); DELETE FROM season_weeks WHERE season_year IN (20070,20071);`)
  for (const user of users) assert.equal((await admin.auth.admin.deleteUser(user)).error, null)
}

import { strict as assert } from 'node:assert'

const db = Deno.env.get('SUPABASE_DB_URL')!
const api = Deno.env.get('SUPABASE_URL')!
const port = Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322'
assert.match(port, /^\d+$/)
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(db).hostname) && new URL(db).port === port)
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(api).hostname) && Number(new URL(api).port) === Number(port) - 1)
const internalToken = Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')!
assert.ok(internalToken)
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
async function sql(source: string) {
  const result = await new Deno.Command('psql', { args: [db, '-XqAtv', 'ON_ERROR_STOP=1', '-c', source], stdout: 'piped', stderr: 'piped' }).output()
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}
const pushes: { data: { pickId: string; notificationEvent: string; outboxId: string } }[] = []
const fake = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async request => {
  const body = await request.json()
  if (new URL(request.url).pathname === '/receipts') return Response.json({ data: Object.fromEntries(body.ids.map((id: string) => [id, { status: 'ok' }])) })
  pushes.push(...body)
  return Response.json({ data: body.map(() => ({ status: 'ok', id: crypto.randomUUID() })) })
})
Deno.env.set('EXPO_PUSH_URL', `http://127.0.0.1:${fake.addr.port}/send`)
Deno.env.set('EXPO_RECEIPTS_URL', `http://127.0.0.1:${fake.addr.port}/receipts`)
Deno.env.set('EXPO_RECEIPT_DELAY_SECONDS', '0')
const serve = Deno.serve
const descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
let worker: Deno.HttpServer<Deno.NetAddr> | undefined
let completed = 0
let busy = 0
let held = false
const workerPort = Number(port) + 59
let wakeHost = 'host.lima.internal'
if (Deno.build.os === 'linux') {
  const project = Deno.readTextFileSync('supabase/config.toml').match(/^project_id\s*=\s*"([A-Za-z0-9_-]+)"/m)?.[1]
  assert.ok(project)
  const gateway = await new Deno.Command('docker', { args: ['inspect', `supabase_db_${project}`, '--format', '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}'], stdout: 'piped', stderr: 'piped' }).output()
  assert.equal(gateway.code, 0, new TextDecoder().decode(gateway.stderr))
  wakeHost = new TextDecoder().decode(gateway.stdout).trim()
  assert.match(wakeHost, /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)[0-9.]+$/)
}
Object.defineProperty(Deno, 'serve', { value: (handler: Deno.ServeHandler) => {
  worker = serve({ hostname: '0.0.0.0', port: workerPort, onListen() {} }, async (request, info) => {
    busy++
    try {
      while (held) await new Promise(resolve => setTimeout(resolve, 10))
      return await handler(request, info)
    } finally { busy--; completed++ }
  })
  return worker
} })
try { await import('../../functions/process-trades/index.ts') } finally { Object.defineProperty(Deno, 'serve', descriptor) }
assert.ok(worker)
const endpoint = `http://127.0.0.1:${workerPort}`
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (input, init) => {
  assert.ok([new URL(api).origin, `http://127.0.0.1:${fake.addr.port}`, endpoint].includes(new URL(input instanceof Request ? input.url : input).origin))
  return nativeFetch(input, init)
}
const cron = JSON.parse(await sql('SELECT COALESCE(json_agg(row_to_json(j)),\'[]\') FROM (SELECT jobid,jobname,active,command FROM cron.job) j')) as { jobid: number; jobname: string; active: boolean; command: string }[]
const vault = JSON.parse(await sql("SELECT COALESCE(json_agg(row_to_json(s)),'[]') FROM (SELECT id,name,decrypted_secret FROM vault.decrypted_secrets WHERE name IN ('pancake_supabase_url','pancake_edge_internal_token')) s")) as { id: string; name: string; decrypted_secret: string }[]
const minute = cron.find(job => job.jobname === 'notification-dispatch-minute')
assert.ok(minute)
const failures: string[] = []
async function check(name: string, action: () => Promise<void>) {
  try { await action(); console.log(JSON.stringify({ name, pass: true })) }
  catch (error) { failures.push(`${name}: ${error}`); console.error(JSON.stringify({ name, pass: false, error: String(error) })) }
}
async function settle(previous = completed) {
  const until = Date.now() + 10000
  while ((completed <= previous || busy) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25))
  assert.ok(completed > previous && !busy, 'Real internal wake must complete')
}
async function drain() {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'x-internal-function-token': internalToken }, body: '{}' })
  assert.equal(response.status, 200, await response.text())
}
const leagues: string[] = [], users: string[] = []
const year = 29471
const players = [crypto.randomUUID(), crypto.randomUUID()]
async function removeLeague(league: string) {
  await sql(`DELETE FROM draft_orders WHERE draft_id IN (SELECT id FROM drafts WHERE league_id=${quote(league)}); DELETE FROM snake_draft_picks WHERE draft_id IN (SELECT id FROM drafts WHERE league_id=${quote(league)}); DELETE FROM draft_picks WHERE league_id=${quote(league)}; DELETE FROM drafts WHERE league_id=${quote(league)}; DELETE FROM leagues WHERE id=${quote(league)}`)
}
try {
  await sql(`SELECT cron.alter_job(jobid,active:=false) FROM cron.job;
    DO $$ DECLARE k text; v text; s uuid; BEGIN
      FOR k,v IN VALUES ('pancake_supabase_url','http://${wakeHost}:${workerPort}'),('pancake_edge_internal_token',${quote(internalToken)}) LOOP
        SELECT id INTO s FROM vault.secrets WHERE name=k;
        IF s IS NULL THEN PERFORM vault.create_secret(v,k); ELSE PERFORM vault.update_secret(s,v); END IF;
      END LOOP;
    END $$;`)
  await sql(`INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number) SELECT id,'Synthetic','Pause rookie','PG',ARRAY['PG'],0,1 FROM unnest(ARRAY[${players.map(quote)}]::uuid[]) id;`)
  for (const timer of [60, 604800]) {
    for (const scenario of ['before', 'after', 'made', 'skipped', 'completed', 'disabled']) {
      const league = crypto.randomUUID(), season = crypto.randomUUID()
      const owners = [crypto.randomUUID(), crypto.randomUUID()], members = [crypto.randomUUID(), crypto.randomUUID()]
      leagues.push(league); users.push(...owners)
      const qLeague = quote(league)
      let before = completed
      held = true
      const draft = await sql(`BEGIN;
        INSERT INTO auth.users(id,email,raw_user_meta_data) SELECT id,id||'@example.test',jsonb_build_object('username',id::text) FROM unnest(ARRAY[${owners.map(quote)}]::uuid[]) id;
        INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_entrants,playoff_round_lengths) VALUES(${qLeague},'Synthetic paused alerts',${qLeague},${quote(owners[0])},'offseason',2,ARRAY[1]);
        INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${quote(season)},${qLeague},${year},true);
        ${members.map((id, i) => `INSERT INTO league_members(id,league_id,user_id,role) VALUES(${quote(id)},${qLeague},${quote(owners[i])},'${i ? 'manager' : 'commissioner'}');`).join('\n')}
        INSERT INTO notification_preferences(user_id,event_settings) SELECT id,(SELECT jsonb_object_agg(event_type,event_type IN ('draft_on_clock','draft_coming_soon','draft_timer_expiring')) FROM notif_event_catalog) FROM unnest(ARRAY[${owners.map(quote)}]::uuid[]) id;
        UPDATE profiles SET push_token='fake-paused-'||id WHERE id IN (${owners.map(quote)});
        INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id) SELECT ${qLeague},${year},1,m,m FROM unnest(ARRAY[${members.map(quote)}]::uuid[]) m;
        SELECT start_rookie_draft_atomic(${qLeague},1,false,${timer})->>'id';
        COMMIT;`)
      const picks = JSON.parse(await sql(`SELECT json_agg(row_to_json(p) ORDER BY overall_pick) FROM snake_draft_picks p WHERE draft_id=${quote(draft)}`)) as { id: string; member_id: string; timer_expires_at: string }[]
      const count = (event: string) => pushes.filter(push => push.data.pickId === picks[0].id && push.data.notificationEvent === event).length
      const rows = () => sql(`SELECT json_agg(json_build_object('id',id,'event',event_type,'suppressed',suppression_reason,'admitted',admitted_at,'delivered',delivered_at)) FROM notification_outbox WHERE data->>'draftId'=${quote(draft)} AND event_type IN ('draft_on_clock','draft_coming_soon','draft_timer_expiring')`)
      if (scenario === 'after') { held = false; await settle(before); await drain(); assert.equal(count('draft_on_clock'), 1) }
      await sql(`SELECT pause_draft_atomic(${quote(draft)});`)
      held = false
      if (scenario !== 'after') await settle(before)
      await drain()
      const gateBefore = await sql("SELECT count(*) FROM edge_invocations WHERE function_name='process-trades'")
      await sql(minute.command)
      assert.equal(await sql("SELECT count(*) FROM edge_invocations WHERE function_name='process-trades'"), gateBefore, 'Paused pending alerts cannot wake the gate every minute')
      console.log(JSON.stringify({ timer, scenario, phase: 'paused', state: JSON.parse(await rows()), pushes: count('draft_on_clock') }))
      await check(`${timer}/${scenario}/paused`, async () => assert.equal(count('draft_on_clock'), scenario === 'after' ? 1 : 0))
      if (scenario === 'before' && timer === 60 && Deno.env.get('NOTIF_PAUSE_SKIP_CRON') !== '1') {
        await sql(`SELECT cron.alter_job(${minute.jobid},active:=true)`)
        const run = Number(await sql(`SELECT COALESCE(max(runid),0) FROM cron.job_run_details WHERE jobid=${minute.jobid}`))
        const until = Date.now() + 65000
        while (Number(await sql(`SELECT COALESCE(max(runid),0) FROM cron.job_run_details WHERE jobid=${minute.jobid} AND end_time IS NOT NULL`)) <= run && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 250))
        assert.ok(Number(await sql(`SELECT COALESCE(max(runid),0) FROM cron.job_run_details WHERE jobid=${minute.jobid} AND end_time IS NOT NULL`)) > run, 'Real minute cron must run while paused')
        await sql(`SELECT cron.alter_job(${minute.jobid},active:=false)`)
        while (Date.now() <= Date.parse(picks[0].timer_expires_at)) await new Promise(resolve => setTimeout(resolve, 100))
        assert.equal(await sql(`SELECT NOT private.notif_is_stale('draft_on_clock',jsonb_build_object('draftId',${quote(draft)},'pickId',${quote(picks[0].id)}))`), 't', 'Elapsed original deadline cannot expire a paused pick')
      }
      before = completed
      if (scenario === 'made') {
        await sql(`SELECT auto_pick_snake_pick_atomic(${quote(draft)},${quote(picks[0].member_id)},'season_boundary_backstop');`)
      } else if (scenario === 'skipped') {
        await sql(`BEGIN; SELECT resume_draft_atomic(${quote(draft)}); UPDATE drafts SET timer_expiry_behavior='skip_pick' WHERE id=${quote(draft)}; UPDATE snake_draft_picks SET timer_expires_at=clock_timestamp()-interval '1 second' WHERE id=${quote(picks[0].id)}; SELECT * FROM process_expired_snake_pick_atomic(${quote(draft)}); COMMIT;`)
      } else if (scenario === 'completed') {
        await sql(`BEGIN; SELECT auto_pick_snake_pick_atomic(${quote(draft)},${quote(picks[0].member_id)},'season_boundary_backstop'); SELECT auto_pick_snake_pick_atomic(${quote(draft)},${quote(picks[1].member_id)},'season_boundary_backstop'); COMMIT;`)
      } else {
        if (scenario === 'disabled') await sql(`UPDATE notification_preferences SET event_settings=event_settings||'{"draft_on_clock":false}' WHERE user_id IN (${owners.map(quote)})`)
        await sql(`SELECT resume_draft_atomic(${quote(draft)});`)
      }
      if (scenario === 'before') await check(`${timer}/resume-immediate-wake`, () => settle(before))
      await sql(minute.command)
      await drain(); await drain()
      await check(`${timer}/${scenario}/result`, async () => {
        assert.equal(count('draft_on_clock'), ['before', 'after'].includes(scenario) ? 1 : 0, await rows())
        assert.equal(await sql(`SELECT count(*) FROM notification_outbox WHERE event_type='draft_on_clock' AND data->>'pickId'=${quote(picks[0].id)}`), '1', 'One row retains the original dedupe key')
        if (scenario === 'before') {
          assert.equal(await sql(`SELECT count(*) FROM notification_outbox o JOIN snake_draft_picks p ON p.id=${quote(picks[0].id)} WHERE o.data->>'pickId'=p.id::text AND o.event_type='draft_on_clock' AND o.admitted_at<p.timer_expires_at AND o.suppressed_at IS NULL AND o.delivered_at IS NOT NULL`), '1')
          assert.equal(pushes.filter(push => push.data.pickId === picks[1].id && push.data.notificationEvent === 'draft_coming_soon').length, 1)
          console.log(JSON.stringify({ timer, resumeToAdmissionMs: await sql(`SELECT round(extract(epoch FROM (o.admitted_at-(SELECT max(created_at) FROM draft_audit_logs WHERE draft_id=${quote(draft)} AND action='resume')))*1000,3) FROM notification_outbox o WHERE event_type='draft_on_clock' AND data->>'pickId'=${quote(picks[0].id)}`) }))
        }
        if (['made','skipped','completed'].includes(scenario)) assert.equal(await sql(`SELECT suppression_reason FROM notification_outbox WHERE event_type='draft_on_clock' AND data->>'pickId'=${quote(picks[0].id)}`), 'stale')
        if (scenario === 'disabled') {
          assert.equal(await sql(`SELECT suppression_reason FROM notification_outbox WHERE event_type='draft_on_clock' AND data->>'pickId'=${quote(picks[0].id)}`), 'preferences_disabled')
          await sql(`UPDATE notification_preferences SET event_settings=event_settings||'{"draft_on_clock":true}' WHERE user_id IN (${owners.map(quote)})`)
          await drain()
          assert.equal(count('draft_on_clock'), 0)
        }
      })
      console.log(JSON.stringify({ timer, scenario, phase: 'final', state: JSON.parse(await rows()), pushes: count('draft_on_clock'), fresh: await sql(`SELECT NOT private.notif_is_stale('draft_on_clock',jsonb_build_object('draftId',${quote(draft)},'pickId',${quote(picks[0].id)}))`) }))
      await removeLeague(league)
    }
  }
  assert.equal(new Set(pushes.map(push => push.data.outboxId)).size, pushes.length, 'Pause/resume cannot repeat any receipted event')
  assert.equal(failures.length, 0, failures.join('\n'))
  console.log('SYNTHETIC: real rookie RPCs, real immediate wake, registered minute cron/gate, 60-second and 7-day timers, fake Expo receipts, pause/resume, no duplicate, terminal stale and opt-out durability')
} finally {
  held = false
  for (const league of leagues) await removeLeague(league)
  await sql(`DELETE FROM auth.users WHERE id IN (${users.map(quote) || "NULL"}); DELETE FROM profiles WHERE id IN (${users.map(quote) || "NULL"});`)
  await sql(`DELETE FROM players WHERE id IN (${players.map(quote)});`)
  for (const name of ['pancake_supabase_url', 'pancake_edge_internal_token']) {
    const previous = vault.find(secret => secret.name === name)
    if (previous) await sql(`SELECT vault.update_secret(${quote(previous.id)},${quote(previous.decrypted_secret)})`)
    else await sql(`DELETE FROM vault.secrets WHERE name=${quote(name)}`)
  }
  for (const job of cron) await sql(`SELECT cron.alter_job(${job.jobid},active:=${job.active})`)
  globalThis.fetch = nativeFetch
  await fake.shutdown()
  await worker.shutdown()
}

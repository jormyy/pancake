import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const target = new URL(process.env.SUPABASE_DB_URL ?? '')
assert.equal(target.hostname, '127.0.0.1')
assert.equal(target.port, process.env.PANCAKE_TEST_DB_PORT)
assert.ok(['/postgres', '/pancake_db_audit_12'].includes(target.pathname))
const environment = { ...process.env, PGHOST: target.hostname, PGPORT: target.port,
  PGDATABASE: target.pathname.slice(1), PGUSER: decodeURIComponent(target.username),
  PGPASSWORD: decodeURIComponent(target.password), PGPASSFILE: '/dev/null', PGSSLMODE: 'disable',
  PGOPTIONS: '-c statement_timeout=6000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=20000' }
const actor = randomUUID(), league = randomUUID()
const report = { checks: 0 }
let locker
let previousPause
let created = false
console.log(JSON.stringify({ fixture: { actor, league } }))

async function run(statement) {
  const start = performance.now()
  const child = spawn('psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], { env: environment })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes })
  child.stderr.on('data', bytes => { stderr += bytes })
  const result = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr, milliseconds: performance.now() - start }))
  })
  const timer = setTimeout(() => child.kill('SIGTERM'), 8000)
  child.stdin.end(statement)
  try { return await result } finally { clearTimeout(timer) }
}

async function query(statement) {
  const result = await run(statement)
  assert.equal(result.code, 0, result.stderr)
  return result.stdout.trim()
}

async function hold(advisory = null) {
  locker = spawn('psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1'], { env: environment })
  let stdout = '', stderr = ''
  const ready = new Promise((resolve, reject) => {
    locker.stdout.on('data', bytes => {
      stdout += bytes
      if (stdout.includes('LOCKED')) resolve()
    })
    locker.stderr.on('data', bytes => { stderr += bytes })
    locker.once('error', reject)
    locker.once('close', code => reject(new Error(`Locker closes before readiness (${code}): ${stderr}`)))
  })
  const statement = advisory
    ? `SELECT pg_advisory_lock(hashtext('${advisory}'))`
    : `SELECT revision FROM public.league_change_hints WHERE league_id='${league}' AND topic='score' FOR UPDATE`
  locker.stdin.write(`BEGIN; ${statement}; SELECT 'LOCKED';\n`)
  await ready
}

async function release() {
  if (!locker) return
  const child = locker
  locker = undefined
  const closed = new Promise(resolve => child.once('close', resolve))
  child.stdin.end('ROLLBACK;\n')
  await closed
}

const isolate = `DELETE FROM private.player_stats_hint_pending WHERE league_id<>'${league}';
DELETE FROM private.league_hint_pending WHERE league_id<>'${league}';`
const state = `SELECT jsonb_build_object('score',(SELECT revision FROM public.league_change_hints WHERE league_id='${league}' AND topic='score'),
'inventory',(SELECT revision FROM public.league_change_hints WHERE league_id='${league}' AND topic='inventory'),
'pendingScore',(SELECT count(*) FROM private.player_stats_hint_pending WHERE league_id='${league}'),
'pendingInventory',(SELECT count(*) FROM private.league_hint_pending WHERE league_id='${league}'));`
try {
  assert.equal(await query("SELECT to_regprocedure('pg_catalog.season_sim_native_now()') IS NULL"), 't', 'Do not contend with an active replay')
  const installed = JSON.parse(await query("SELECT jsonb_build_object('command',command,'schedule',schedule) FROM cron.job WHERE jobname='io-hint-drain'"))
  assert.equal(installed.schedule, '* * * * *')
  assert.match(installed.command, /private\.flush_player_stats_hints\(\)/)
  assert.match(installed.command, /private\.flush_league_inventory_hints\(1000\)/)
  previousPause = await query('SELECT paused FROM private.worker_controls WHERE id')
  await query(`BEGIN;
INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES('${actor}','${actor}@example.test','{}');
INSERT INTO public.leagues(id,name,slug,commissioner_id,status) VALUES('${league}','Hint timeout fixture','${league}','${actor}','active');
INSERT INTO public.league_change_hints(league_id,topic,revision,updated_at) VALUES
('${league}','score',10,clock_timestamp()-interval '2 minutes'),('${league}','inventory',20,clock_timestamp()-interval '2 minutes')
ON CONFLICT(league_id,topic) DO UPDATE SET revision=EXCLUDED.revision,updated_at=EXCLUDED.updated_at;
DELETE FROM private.player_stats_hint_pending WHERE league_id='${league}';
DELETE FROM private.league_hint_pending WHERE league_id='${league}';
INSERT INTO private.player_stats_hint_pending(league_id) VALUES('${league}');
INSERT INTO private.league_hint_pending(league_id) VALUES('${league}');
UPDATE private.worker_controls SET paused=false WHERE id;
COMMIT;`)
  created = true
  report.unblockedPlans = await query(`BEGIN; ${isolate}
EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) SELECT private.flush_player_stats_hints();
EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) SELECT private.flush_league_inventory_hints(1000);
${state} ROLLBACK;`)
  await hold()
  await query('UPDATE private.worker_controls SET paused=true WHERE id')
  const paused = await run(`BEGIN; ${isolate} ${installed.command}; ROLLBACK;`)
  assert.equal(paused.code, 0, paused.stderr)
  report.checks += 1
  await query('UPDATE private.worker_controls SET paused=false WHERE id')
  const blocked = await run(`SET statement_timeout='1500ms'; SET lock_timeout='0'; BEGIN; ${isolate} ${installed.command}; ROLLBACK;`)
  report.blocked = { code: blocked.code, milliseconds: blocked.milliseconds, sqlstate: /ERROR:\s+([A-Z0-9]{5}):/.exec(blocked.stderr)?.[1] }
  assert.equal(report.blocked.sqlstate, '55P03', `Hint drain lacks a lock bound: ${JSON.stringify(report.blocked)}`)
  assert.ok(blocked.milliseconds < 1200)
  report.checks += 2
  const retained = JSON.parse(await query(state))
  assert.deepEqual(retained, { score: 10, inventory: 20, pendingScore: 1, pendingInventory: 1 })
  report.checks += 1
  await release()
  const retried = await query(`BEGIN; ${isolate} ${installed.command}; ${installed.command}; ${state} ROLLBACK;`)
  const result = JSON.parse(retried.split('\n').at(-1))
  assert.deepEqual(result, { score: 11, inventory: 21, pendingScore: 0, pendingInventory: 0 })
  report.retryResult = result
  report.checks += 1
  const prefix = installed.command.slice(0, installed.command.indexOf('DO $job$'))
  const slow = await run(`SET statement_timeout='6s'; ${prefix} SELECT pg_sleep(6);`)
  report.slow = { milliseconds: slow.milliseconds, sqlstate: /ERROR:\s+([A-Z0-9]{5}):/.exec(slow.stderr)?.[1] }
  assert.equal(report.slow.sqlstate, '57014')
  assert.ok(slow.milliseconds < 5500)
  report.checks += 2
  await hold('io-hint-drain')
  const overlapping = await run(`BEGIN; ${isolate} ${installed.command}; ${state} ROLLBACK;`)
  assert.equal(overlapping.code, 0, overlapping.stderr)
  assert.ok(overlapping.milliseconds < 1000)
  assert.deepEqual(JSON.parse(overlapping.stdout.trim().split('\n').at(-1)), retained)
  report.overlapMilliseconds = overlapping.milliseconds
  report.checks += 3
  await release()
  report.complete = true
} finally {
  await release()
  if (created) {
    await query(`BEGIN; DELETE FROM private.player_stats_hint_pending WHERE league_id='${league}';
DELETE FROM private.league_hint_pending WHERE league_id='${league}';
DELETE FROM public.leagues WHERE id='${league}';
DELETE FROM public.league_change_hints WHERE league_id='${league}';
DELETE FROM auth.users WHERE id='${actor}';
UPDATE private.worker_controls SET paused=${previousPause === 't' ? 'true' : 'false'} WHERE id; COMMIT;`)
    assert.equal(await query(`SELECT count(*) FROM public.leagues WHERE id='${league}'`), '0')
  }
  console.log(JSON.stringify(report))
}

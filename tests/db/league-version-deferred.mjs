import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const db = process.env.SUPABASE_DB_URL
assert(db && ['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
const prefix = `owned-hints-${randomUUID()}`
const quote = value => `'${String(value).replaceAll("'", "''")}'`
const list = values => values.map(quote).join(',')

class Session {
  constructor(name) {
    this.pending = null; this.buffer = ''; this.lines = []; this.stderr = ''; this.ended = false
    this.child = spawn('psql', [db, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
      env: { ...process.env, PGAPPNAME: `${prefix}-${name}`,
        PGOPTIONS: '-c statement_timeout=20000 -c lock_timeout=18000 -c idle_in_transaction_session_timeout=30000' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk
      let at
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at).replace(/\r$/, ''); this.buffer = this.buffer.slice(at + 1)
        if (this.pending && line === this.pending.marker) {
          const pending = this.pending; this.pending = null; clearTimeout(pending.timer)
          const output = this.lines.join('\n').trim(); this.lines = []; pending.resolve(output)
        } else this.lines.push(line)
      }
    })
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk })
    this.closed = new Promise((resolve) => {
      const end = (code, error) => {
        this.ended = true
        if (this.pending) {
          clearTimeout(this.pending.timer)
          this.pending.reject(error ?? new Error(`Own SQL connection closes (${code}): ${this.stderr}`)); this.pending = null
        }
        resolve(code)
      }
      this.child.on('error', (error) => end(-1, error)); this.child.on('close', (code) => end(code))
    })
  }
  query(statement) {
    assert.equal(this.pending, null); assert.equal(this.ended, false)
    return new Promise((resolve, reject) => {
      const marker = `DONE_${randomUUID()}`
      const timer = setTimeout(() => { this.child.kill('SIGTERM'); reject(new Error('Own SQL query exceeds 25 seconds')) }, 25000)
      this.pending = { marker, resolve, reject, timer }
      this.child.stdin.write(`${statement};\nSELECT ${quote(marker)};\n`)
    })
  }
  close() {
    if (!this.closePromise) this.closePromise = (async () => {
      if (this.pending) this.child.kill('SIGTERM')
      else if (!this.ended) await this.query('ROLLBACK;').catch(() => {})
      this.child.stdin.end(); await this.closed
    })()
    return this.closePromise
  }
}
const target = new URL(db)
assert.equal(target.port, process.env.PANCAKE_TEST_DB_PORT ?? '57422')
const root = new Session('root'), first = new Session('first'), second = new Session('second')
const users = [randomUUID(), randomUUID()], members = [randomUUID(), randomUUID()]
const league = randomUUID(), season = randomUUID()
let checks = 0
try {
  await root.query(`BEGIN;
INSERT INTO auth.users(id,email,raw_user_meta_data) SELECT id,id||'@example.test','{}' FROM unnest(ARRAY[${list(users)}]::uuid[]) id;
INSERT INTO public.leagues(id,name,slug,commissioner_id,status,waiver_mode) VALUES(${quote(league)},'Deferred version',${quote(league)},${quote(users[0])},'active','faab');
INSERT INTO public.league_members(id,league_id,user_id,role,team_name)
 SELECT member,${quote(league)},actor,'manager','Deferred' FROM unnest(ARRAY[${list(members)}]::uuid[],ARRAY[${list(users)}]::uuid[]) pair(member,actor);
INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(${quote(season)},${quote(league)},2169,true);
COMMIT;`)
  const version = Number(await root.query(`SELECT version FROM public.league_versions WHERE league_id=${quote(league)}`))
  await second.query(`BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT version FROM public.league_versions WHERE league_id=${quote(league)};`)
  await first.query(`BEGIN; UPDATE public.faab_balances SET balance=balance-1 WHERE league_id=${quote(league)} AND member_id=${quote(members[0])}; COMMIT;`)
  await second.query(`UPDATE public.faab_balances SET balance=balance-1 WHERE league_id=${quote(league)} AND member_id=${quote(members[1])}; COMMIT;`)
  assert.equal(Number(await root.query(`SELECT version FROM public.league_versions WHERE league_id=${quote(league)}`)), version + 1)
  assert.equal(await root.query(`SELECT count(*) FROM private.league_version_pending WHERE league_id=${quote(league)} AND pg_xact_status(transaction_id)='committed'`), '1')
  checks += 2
  await root.query(`UPDATE private.screen_refresh_queue SET dirty=false WHERE league_id=${quote(league)}; SELECT set_config('request.jwt.claim.sub',${quote(users[0])},false);`)
  assert.equal(await root.query(`SELECT public.view_context(${quote(league)},${quote(members[0])},jsonb_build_object('seasonId',${quote(season)}))->>'stale'`), 'true')
  checks += 1
  await first.query(`BEGIN; SELECT transaction_id FROM private.league_version_pending WHERE league_id=${quote(league)} FOR UPDATE;`)
  assert.equal(await second.query('SELECT private.flush_deferred_league_versions(1000)'), '0')
  await first.query('ROLLBACK;')
  const drained = await Promise.all([first.query('SELECT private.flush_deferred_league_versions(1000)'), second.query('SELECT private.flush_deferred_league_versions(1000)')])
  assert.equal(drained.map(Number).reduce((a,b) => a+b,0), 1)
  assert.equal(Number(await root.query(`SELECT version FROM public.league_versions WHERE league_id=${quote(league)}`)), version + 2)
  assert.equal(await root.query(`SELECT count(*) FROM private.league_version_pending WHERE league_id=${quote(league)}`), '0')
  assert.equal(await root.query(`SELECT count(*) FROM public.league_changes WHERE league_id=${quote(league)} AND version>${version}`), '2')
  checks += 5
  assert.equal(await root.query(`SELECT bool_and(NOT has_function_privilege(role,'private.flush_deferred_league_versions(integer)','EXECUTE') AND NOT has_function_privilege(role,'private.publish_league_version(uuid,text[],text[])','EXECUTE')) FROM unnest(ARRAY['anon','authenticated','service_role']) role`), 't')
  checks += 1
  await root.query(`UPDATE private.screen_refresh_queue SET dirty=false WHERE league_id=${quote(league)}`)
  assert.equal(await root.query(`SELECT public.view_context(${quote(league)},${quote(members[0])},jsonb_build_object('seasonId',${quote(season)}))->>'stale'`), 'false')
  checks += 1
  const matchup = randomUUID(), token = randomUUID()
  await root.query(`BEGIN;
INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
VALUES(${quote(matchup)},${quote(league)},${quote(season)},1,${quote(members[0])},${quote(members[1])});
INSERT INTO private.matchup_forecast_queue(matchup_id,revision,dirty,claim_token,claimed_revision,claimed_at)
VALUES(${quote(matchup)},1,true,${quote(token)},1,now())
ON CONFLICT(matchup_id) DO UPDATE SET revision=1,dirty=true,claim_token=${quote(token)},claimed_revision=1,claimed_at=now();
UPDATE private.screen_refresh_queue SET dirty=false WHERE league_id=${quote(league)};
COMMIT;`)
  const screenBefore = await root.query(`SELECT jsonb_build_object('version',version,'dirty',dirty) FROM private.screen_refresh_queue WHERE league_id=${quote(league)}`)
  const forecastVersion = Number(await root.query(`SELECT version FROM public.league_versions WHERE league_id=${quote(league)}`))
  const forecast = JSON.stringify({ modelVersion: 'contention-fixture', teams: [{ memberId: members[0] }, { memberId: members[1] }] })
  const plan = await root.query(`BEGIN;
EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) SELECT public.complete_matchup_forecast(${quote(matchup)},1,${quote(token)},${quote(forecast)},now()+interval '1 hour');
ROLLBACK;`)
  console.log(JSON.stringify({ forecastPublicationPlan: JSON.parse(plan) }))
  await first.query(`BEGIN; SELECT version FROM private.screen_refresh_queue WHERE league_id=${quote(league)} FOR UPDATE;`)
  const started = performance.now()
  const saved = await second.query(`SET lock_timeout='250ms';
SELECT public.complete_matchup_forecast(${quote(matchup)},1,${quote(token)},${quote(forecast)},now()+interval '1 hour');`)
  console.log(JSON.stringify({ contendedForecastMilliseconds: performance.now() - started }))
  assert.equal(saved, 't', 'Forecast publication must not wait for an unrelated screen refresh')
  assert.ok(performance.now() - started < 1000)
  assert.equal(await root.query(`SELECT jsonb_build_object('version',version,'dirty',dirty) FROM private.screen_refresh_queue WHERE league_id=${quote(league)}`), screenBefore)
  assert.equal(Number(await root.query(`SELECT version FROM public.league_versions WHERE league_id=${quote(league)}`)), forecastVersion + 1)
  assert.equal(await root.query(`SELECT dirty FROM private.matchup_forecast_queue WHERE matchup_id=${quote(matchup)}`), 'f')
  await first.query('ROLLBACK;')
  checks += 5
  await second.query(`BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT version FROM public.league_versions WHERE league_id=${quote(league)};`)
  await first.query(`BEGIN; UPDATE public.faab_balances SET balance=balance-1 WHERE league_id=${quote(league)} AND member_id=${quote(members[0])}; COMMIT;`)
  await second.query(`SELECT private.league_version_enqueue(${quote(league)},'membership','league_members');`)
  await assert.rejects(second.query('COMMIT;'), /could not serialize access/)
  assert.equal(await root.query(`SELECT count(*) FROM private.league_version_pending WHERE league_id=${quote(league)}`), '0')
  checks += 2
  console.log(JSON.stringify({ checks, staleReadsGuarded: true, deferredVersionPublishesOnce: true, membershipConflictsStillAbort: true }))
} finally {
  await first.close()
  await second.close()
  await root.query(`BEGIN; DELETE FROM private.league_version_pending WHERE league_id=${quote(league)}; DELETE FROM public.leagues WHERE id=${quote(league)}; DELETE FROM private.league_hint_pending WHERE league_id=${quote(league)}; DELETE FROM public.league_change_hints WHERE league_id=${quote(league)}; DELETE FROM auth.users WHERE id IN (${list(users)}); COMMIT;`)
  await root.close()
}

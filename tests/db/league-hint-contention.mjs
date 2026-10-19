import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const db = process.env.SUPABASE_DB_URL
assert(db && ['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
const prefix = `owned-hints-${randomUUID()}`
const quote = value => `'${String(value).replaceAll("'", "''")}'`
const list = values => values.map(quote).join(',')
const parse = JSON.parse
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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
const root = new Session('inspector'), first = new Session('first'), second = new Session('second')
const users = [randomUUID(), randomUUID()]
const leagues = [0, 1].map(() => ({ id: randomUUID(), season: randomUUID(), members: [randomUUID(), randomUUID()] }))
const leagueIds = list(leagues.map(row => row.id))
const update = (league, member) => `UPDATE public.faab_balances SET balance=balance-1 WHERE league_id=${quote(league.id)} AND member_id=${quote(league.members[member])};`
const revision = league => root.query(`SELECT revision FROM public.league_change_hints WHERE league_id=${quote(league.id)} AND topic='inventory'`).then(Number)
const queued = () => root.query(`SELECT count(*) FROM private.league_hint_pending WHERE league_id IN (${leagueIds})`).then(Number)
const flush = () => root.query('SELECT private.flush_league_inventory_hints(1000)').then(Number)
let pending
let checks = 0
async function withoutHintWait(statement, label) {
  let finished = false
  pending = second.query(statement).then(output => ({ output }), error => ({ error })).finally(() => { finished = true })
  const deadline = Date.now() + 5000
  while (!finished && Date.now() < deadline) {
    const waits = parse(await root.query(`SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'application',a.application_name,'wait_type',a.wait_event_type,'wait_event',a.wait_event,
      'blockers',pg_blocking_pids(a.pid),'locks',(SELECT jsonb_agg(jsonb_build_object('type',l.locktype,
      'relation',l.relation::regclass::text,'page',l.page,'tuple',l.tuple,'granted',l.granted))
      FROM pg_locks l WHERE l.pid=a.pid))), '[]') FROM pg_stat_activity a
      WHERE a.application_name=${quote(prefix+'-second')} AND a.wait_event_type='Lock'`))
    if (waits.length) {
      console.log(JSON.stringify({ label, waits }))
      assert.fail('Independent balance writes must not wait on a shared hint row')
    }
    await sleep(20)
  }
  assert(finished, `${label}: independent writer must finish while the first transaction stays open`)
  const result = await pending
  pending = null
  if (result.error) throw result.error
  checks++
}
try {
  await root.query(`DO $drain$ BEGIN
    IF to_regprocedure('private.flush_league_inventory_hints(integer)') IS NOT NULL THEN
      PERFORM private.flush_league_inventory_hints(5000);
    END IF;
  END $drain$;`)
  await root.query(`BEGIN;
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    SELECT id,'authenticated','authenticated',id||'@example.test','x',now(),'{}','{}',now(),now() FROM unnest(ARRAY[${list(users)}]::uuid[]) id;
    ${leagues.map(league => `INSERT INTO public.leagues(id,name,slug,commissioner_id,status,waiver_mode)
      VALUES(${quote(league.id)},'Owned hint contention',${quote(league.id)},${quote(users[0])},'active','faab');
      INSERT INTO public.league_members(id,league_id,user_id,role,team_name)
      SELECT member,${quote(league.id)},actor,'manager','Owned' FROM unnest(ARRAY[${list(league.members)}]::uuid[],ARRAY[${list(users)}]::uuid[]) pair(member,actor);
      INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(${quote(league.season)},${quote(league.id)},2167,true);
      INSERT INTO public.faab_balances(league_id,league_season_id,member_id,balance)
      SELECT ${quote(league.id)},${quote(league.season)},id,100 FROM unnest(ARRAY[${list(league.members)}]::uuid[]) id
      ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET balance=100;`).join(' ')}
    COMMIT;`)
  const before = [await revision(leagues[0]), await revision(leagues[1])]
  await first.query(`BEGIN; ${update(leagues[0], 0)}`)
  await second.query(`BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT count(*) FROM public.league_change_hints WHERE league_id IN (${leagueIds}); ${update(leagues[1], 1)}`)
  await withoutHintWait(`${update(leagues[0], 1)} COMMIT;`, 'two-league batch with distinct member balances')
  assert.equal(await queued(), 1)
  assert.equal(await flush(), 0, 'Busy aggregate row defers the drain without blocking')
  await first.query('COMMIT;')
  assert.equal(await revision(leagues[0]), before[0] + 1)
  assert.equal(await revision(leagues[1]), before[1] + 1)
  assert.equal(await flush(), 1)
  assert.equal(await revision(leagues[0]), before[0] + 2)
  assert.equal(await queued(), 0)
  checks += 7

  const staleBefore = await revision(leagues[0])
  await second.query(`BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT revision FROM public.league_change_hints WHERE league_id=${quote(leagues[0].id)} AND topic='inventory';`)
  await first.query(`BEGIN; ${update(leagues[0], 0)} COMMIT;`)
  await withoutHintWait(`${update(leagues[0], 1)} COMMIT;`, 'old snapshot with independent balances')
  assert.equal(await queued(), 1)
  assert.equal(await flush(), 1)
  assert.equal(await revision(leagues[0]), staleBefore + 2)
  assert.equal(await flush(), 0)
  assert.equal(await revision(leagues[0]), staleBefore + 2)
  checks += 5

  const rollbackBefore = await revision(leagues[0])
  const balancesBefore = await root.query(`SELECT jsonb_agg(to_jsonb(b) ORDER BY member_id) FROM public.faab_balances b WHERE league_id=${quote(leagues[0].id)}`)
  await first.query(`BEGIN; ${update(leagues[0], 0)}`)
  await second.query('BEGIN;')
  await withoutHintWait(`${update(leagues[0], 1)} ROLLBACK;`, 'queued hint rolls back with business write')
  await first.query('ROLLBACK;')
  assert.equal(await queued(), 0)
  assert.equal(await revision(leagues[0]), rollbackBefore)
  assert.equal(await root.query(`SELECT jsonb_agg(to_jsonb(b) ORDER BY member_id) FROM public.faab_balances b WHERE league_id=${quote(leagues[0].id)}`), balancesBefore)
  checks += 3

  const aggregateBefore = await revision(leagues[0])
  await first.query(`BEGIN; ${update(leagues[0], 0)}`)
  await second.query('BEGIN;')
  await withoutHintWait(`${update(leagues[0], 1)} ${update(leagues[0], 1)} COMMIT;`, 'multiple deferred revisions')
  assert.equal(await queued(), 2)
  await first.query('ROLLBACK;')
  assert.equal(await flush(), 2)
  assert.equal(await revision(leagues[0]), aggregateBefore + 2)
  assert.equal(await root.query(`SELECT details IS NULL AND scopes IS NULL FROM public.league_change_hints WHERE league_id=${quote(leagues[0].id)} AND topic='inventory'`), 't')
  assert.equal(await flush(), 0)
  checks += 5

  const access = parse(await root.query(`SELECT jsonb_agg(jsonb_build_object('role',role,
    'table',has_table_privilege(role,'private.league_hint_pending','SELECT,INSERT,UPDATE,DELETE'),
    'emit',has_function_privilege(role,'private.publish_league_inventory_hint(uuid,jsonb)','EXECUTE'),
    'flush',has_function_privilege(role,'private.flush_league_inventory_hints(integer)','EXECUTE')))
    FROM unnest(ARRAY['anon','authenticated','service_role']) role`))
  assert(access.every(row => !row.table && !row.emit && !row.flush))
  checks++
  console.log(JSON.stringify({ checks, independentWritesDoNotWait: true, staleSnapshotPreservesBusinessWrite: true, queuedHintsDrainExactlyOnce: true, rollbackAtomic: true, access }))
} catch (error) {
  console.error(error)
  throw error
} finally {
  await first.close()
  if (pending) await pending
  await second.close()
  const cleaner = root.ended ? new Session('cleanup') : root
  await cleaner.query(`BEGIN;
    DELETE FROM public.leagues WHERE id IN (${leagueIds});
    DELETE FROM public.league_change_hints WHERE league_id IN (${leagueIds});
    DELETE FROM auth.users WHERE id IN (${list(users)});
    DO $cleanup$ BEGIN IF to_regclass('private.league_hint_pending') IS NOT NULL THEN
      DELETE FROM private.league_hint_pending WHERE league_id IN (${leagueIds});
    END IF; END $cleanup$;
    COMMIT;`)
  assert.equal(await cleaner.query(`SELECT (SELECT count(*) FROM public.leagues WHERE id IN (${leagueIds})) + (SELECT count(*) FROM auth.users WHERE id IN (${list(users)}))`), '0')
  if (cleaner !== root) await cleaner.close()
  await root.close()
  console.log(JSON.stringify({ ownedFixtureCleanup: 0 }))
}

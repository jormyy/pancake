// Actual waiver-editor overlap controls. Requires an isolated local database.
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
const db = process.env.SUPABASE_DB_URL
assert(db && ['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
const expectation = process.argv[2] ?? 'repaired'
assert(['deadlock', 'repaired'].includes(expectation))
const prefix = `owned-waiver-editor-${randomUUID()}`
const q = value => `'${String(value).replaceAll("'", "''")}'`
const list = values => values.map(q).join(',')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const print = (stage, data) => console.log(JSON.stringify({ stage, ...data }))
const sessions = [], fixtures = []
class Session {
  constructor(name) {
    this.pending = null; this.buffer = ''; this.lines = []; this.stderr = ''; this.ended = false
    this.child = spawn('psql', [db, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
      env: { PATH: process.env.PATH, PGAPPNAME: `${prefix}-${name}`,
        PGOPTIONS: '-c statement_timeout=10000 -c lock_timeout=8000 -c idle_in_transaction_session_timeout=15000' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.on('data', chunk => {
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
    this.child.stderr.on('data', chunk => { this.stderr += chunk })
    this.closed = new Promise(resolve => {
      const end = (code, error) => {
        this.ended = true
        if (this.pending) {
          clearTimeout(this.pending.timer)
          this.pending.reject(error ?? new Error(`Own SQL connection closes (${code}): ${this.stderr}`)); this.pending = null
        }
        resolve(code)
      }
      this.child.on('error', error => end(-1, error)); this.child.on('close', code => end(code))
    })
  }
  query(statement) {
    assert.equal(this.pending, null); assert.equal(this.ended, false)
    return new Promise((resolve, reject) => {
      const marker = `DONE_${randomUUID()}`
      const timer = setTimeout(() => { this.child.kill('SIGTERM'); reject(new Error('Own SQL query exceeds 12 seconds')) }, 12000)
      this.pending = { marker, resolve, reject, timer }
      this.child.stdin.write(`${statement}\nSELECT ${q(marker)};\n`)
    })
  }
  async close() {
    if (this.pending) this.child.kill('SIGTERM')
    else if (!this.ended) await this.query('ROLLBACK;').catch(() => {})
    this.child.stdin.end(); await this.closed
  }
}
const root = new Session('inspector')
const open = name => { const session = new Session(name); sessions.push(session); return session }
const helper = `CREATE FUNCTION pg_temp.capture_editor(c uuid,m uuid,u uuid,p uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER AS $cap$ BEGIN
  PERFORM public.edit_waiver_claim_atomic(c,m,u,p,0,1);
  RETURN jsonb_build_object('ok',true,'role',current_user);
EXCEPTION WHEN query_canceled THEN RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user);
WHEN OTHERS THEN RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user); END $cap$;
CREATE FUNCTION pg_temp.capture_drop(r uuid,s uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER AS $cap$ BEGIN
  PERFORM public.drop_player_atomic(r,s,NULL::uuid);
  RETURN jsonb_build_object('ok',true,'role',current_user,'subject',auth.uid());
EXCEPTION WHEN query_canceled THEN RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user,'subject',auth.uid());
WHEN OTHERS THEN RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user,'subject',auth.uid()); END $cap$;
CREATE FUNCTION pg_temp.capture_completion(t uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER AS $cap$ BEGIN
  PERFORM public.complete_accepted_trade_atomic(t);
  RETURN jsonb_build_object('ok',true,'role',current_user);
EXCEPTION WHEN query_canceled THEN RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user);
WHEN OTHERS THEN RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user); END $cap$;`
const authenticated = (f, index) => `SET LOCAL ROLE authenticated;
DO $jwt$ BEGIN
PERFORM set_config('request.jwt.claim.sub',${q(f.users[index])},true);
PERFORM set_config('request.jwt.claims',${q(JSON.stringify({ sub: f.users[index], role: 'authenticated' }))},true);
END $jwt$;`
const editSql = (f, drop, user = f.users[0]) => `SET LOCAL ROLE service_role;
SELECT pg_temp.capture_editor(${q(f.claim)},${q(f.members[0])},${q(user)},${drop ? q(drop) : 'NULL::uuid'});`
const operationSql = f => f.kind === 'trade'
  ? `SET LOCAL ROLE service_role; SELECT pg_temp.capture_completion(${q(f.trade)});`
  : `${authenticated(f, 0)} SELECT pg_temp.capture_drop(${q(f.rosters[0])},${q(f.season)});`
const stateSql = f => `SELECT jsonb_build_object(
  'rosters',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.roster_players r WHERE league_id=${q(f.league)}),
  'claims',(SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM public.waiver_claims c WHERE league_id=${q(f.league)}),
  'trades',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM public.trades t WHERE league_id=${q(f.league)}),
  'balances',(SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY member_id),'[]') FROM public.faab_balances b WHERE league_id=${q(f.league)}),
  'priorities',(SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY member_id),'[]') FROM public.waiver_priorities w WHERE league_id=${q(f.league)}),
  'wire',(SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY id),'[]') FROM public.waiver_wire_log w WHERE league_id=${q(f.league)}),
  'transactions',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.roster_transactions r WHERE league_id=${q(f.league)}),
  'activity',(SELECT count(*) FROM public.league_activity WHERE league_id=${q(f.league)}),
  'outbox',(SELECT count(*) FROM public.notification_outbox WHERE member_id IN (${list(f.members)})));`
const state = async f => JSON.parse(await root.query(stateSql(f)))
async function fixture(kind, outcome) {
  const f = { kind, outcome, league: randomUUID(), season: randomUUID(),
    users: Array.from({ length: 3 }, () => randomUUID()), members: Array.from({ length: 3 }, () => randomUUID()),
    players: Array.from({ length: 3 }, () => randomUUID()), rosters: Array.from({ length: 3 }, () => randomUUID()) }
  fixtures.push(f)
  print('owned-fixture-manifest', {fixture:f})
  f.scopes = [`league:${f.league}`, `season:${f.season}`, ...f.players.map(id => `player:${id}`)]
  assert.equal(await root.query(`SELECT
    (SELECT count(*) FROM auth.users WHERE id IN (${list(f.users)}))+
    (SELECT count(*) FROM public.leagues WHERE id=${q(f.league)})+
    (SELECT count(*) FROM public.players WHERE id IN (${list(f.players)}))+
    (SELECT count(*) FROM public.league_members WHERE id IN (${list(f.members)}))+
    (SELECT count(*) FROM public.league_seasons WHERE id=${q(f.season)})+
    (SELECT count(*) FROM public.roster_players WHERE id IN (${list(f.rosters)}))+
    (SELECT count(*) FROM private.score_input_revisions WHERE scope IN (${list(f.scopes)}));`), '0')
  f.mayClean = true
  await root.query(`BEGIN;
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      SELECT id,'authenticated','authenticated',id||'@example.test','x',now(),'{}','{}',now(),now()
      FROM unnest(ARRAY[${list(f.users)}]::uuid[]) id;
    INSERT INTO public.leagues(id,name,slug,commissioner_id,status,waiver_mode,trade_deadline,trade_veto_mode,trade_veto_window_hours,roster_size,weekly_add_limit)
      VALUES(${q(f.league)},'Owned editor concurrency',${q(f.league)},${q(f.users[0])},'active','rolling',NULL,'member_vote',24,20,NULL);
    INSERT INTO public.league_members(id,league_id,user_id,role,team_name)
      SELECT m,${q(f.league)},u,(CASE WHEN n=1 THEN 'commissioner' ELSE 'manager' END)::public.league_member_role,'Owned '||n
      FROM unnest(ARRAY[${list(f.members)}]::uuid[],ARRAY[${list(f.users)}]::uuid[]) WITH ORDINALITY t(m,u,n);
    INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(${q(f.season)},${q(f.league)},2167,true);
    INSERT INTO public.waiver_priorities(league_id,league_season_id,member_id,priority)
      SELECT ${q(f.league)},${q(f.season)},id,n::int FROM unnest(ARRAY[${list(f.members)}]::uuid[]) WITH ORDINALITY t(id,n);
    INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team,years_exp)
      SELECT id,'Synthetic',id::text,'PG',ARRAY['PG'],NULL,2 FROM unnest(ARRAY[${list(f.players)}]::uuid[]) id;
    INSERT INTO public.roster_players(id,player_id,member_id,league_id,league_season_id,acquired_via,is_on_ir,is_on_taxi)
      SELECT r,p,m,${q(f.league)},${q(f.season)},'draft',false,false
      FROM unnest(ARRAY[${list(f.rosters)}]::uuid[],ARRAY[${list(f.players)}]::uuid[],ARRAY[${list(f.members)}]::uuid[]) t(r,p,m);
    COMMIT;`)
  await root.query(`BEGIN; ${authenticated(f, 2)} DO $drop$ BEGIN
    PERFORM public.drop_player_atomic(${q(f.rosters[2])},${q(f.season)},NULL::uuid); END $drop$; COMMIT;`)
  f.claim = await root.query(`BEGIN; SET LOCAL ROLE service_role;
    SELECT public.create_waiver_claim_atomic(${q(f.league)},${q(f.members[0])},${q(f.players[2])},${q(f.players[0])},${q(f.users[0])},0,1); COMMIT;`)
  assert.match(f.claim, /^[0-9a-f-]{36}$/)
  const positive = JSON.parse(await root.query(`BEGIN; ${editSql(f, f.players[0])} COMMIT;`))
  assert.equal(positive.ok, true); assert.equal(positive.role, 'service_role')
  const prior = await state(f)
  const denial = JSON.parse(await root.query(`BEGIN; ${editSql(f, null, f.users[1])} COMMIT;`))
  assert.equal(denial.sqlstate, '42501'); assert.deepEqual(await state(f), prior)
  if (kind === 'trade') {
    f.trade = await root.query(`BEGIN; SET LOCAL ROLE service_role;
      SELECT public.propose_trade_atomic(${q(f.league)},${q(f.season)},${q(f.members[0])},${q(f.members[1])},
        ARRAY[${q(f.players[0])}]::uuid[],ARRAY[${q(f.players[1])}]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],
        'Owned editor trade',now()+interval '1 day',0,0); COMMIT;`)
    assert.match(f.trade, /^[0-9a-f-]{36}$/)
    const accepted = JSON.parse(await root.query(`BEGIN; SET LOCAL ROLE service_role;
      SELECT public.accept_trade_atomic(${q(f.trade)},${q(f.members[1])}); COMMIT;`))
    assert.equal(accepted.allAccepted, true)
    await root.query(`UPDATE public.trades SET veto_window_expires_at=clock_timestamp()-interval '1 second' WHERE id=${q(f.trade)} AND status='accepted';`)
    const reservedBefore = await state(f)
    const reserved = JSON.parse(await root.query(`BEGIN; ${editSql(f, f.players[0])} COMMIT;`))
    assert.equal(reserved.sqlstate, 'P0001'); assert.match(reserved.message, /reserved|accepted trade/i)
    assert.deepEqual(await state(f), reservedBefore)
    assert.equal(await root.query(`SELECT c.status='pending' AND c.drop_player_id=${q(f.players[0])} AND c.submitted_at<=t.accepted_at
      FROM public.waiver_claims c JOIN public.trades t ON t.id=${q(f.trade)} WHERE c.id=${q(f.claim)};`), 't')
  }
  print('actual-uncontended-controls', { kind, outcome, positive, denial })
  return f
}
function prefixSql(f) {
  if (f.kind === 'drop') return `DO $prefix$ BEGIN
    PERFORM pg_advisory_xact_lock(hashtext(${q(f.league)}),hashtext(${q(f.members[0])}));
    PERFORM pg_advisory_xact_lock(hashtext(${q(f.league)}),hashtext(${q(f.players[0])}));
    PERFORM 1 FROM public.roster_players WHERE id=${q(f.rosters[0])} FOR UPDATE;
  END $prefix$;`
  // Exact unchanged completion prefix: trade, sorted members, sorted players, league.
  return `DO $prefix$ DECLARE lock_id uuid; BEGIN
    PERFORM 1 FROM public.trades WHERE id=${q(f.trade)} FOR UPDATE;
    FOR lock_id IN SELECT m FROM unnest(ARRAY[${list(f.members.slice(0, 2))}]::uuid[]) m ORDER BY m LOOP
      PERFORM pg_advisory_xact_lock(hashtext(${q(f.league)}),hashtext(lock_id::text)); END LOOP;
    FOR lock_id IN SELECT p FROM unnest(ARRAY[${list(f.players.slice(0, 2))}]::uuid[]) p ORDER BY p LOOP
      PERFORM pg_advisory_xact_lock(hashtext(${q(f.league)}),hashtext(lock_id::text)); END LOOP;
    PERFORM 1 FROM public.leagues WHERE id=${q(f.league)} FOR UPDATE;
  END $prefix$;`
}
const waitsSql = (a, b) => `SELECT COALESCE(jsonb_agg(jsonb_build_object('pid',pid,'blockers',pg_blocking_pids(pid),
  'wait_type',wait_event_type,'wait',wait_event) ORDER BY pid),'[]') FROM pg_stat_activity WHERE pid IN (${a},${b});`
async function firstWait(a, b, settled) {
  const until = Date.now() + 3000
  while (Date.now() < until) {
    const rows = JSON.parse(await root.query(waitsSql(a, b)))
    if (rows.some(row => row.pid === b && row.blockers.includes(a))) return rows
    assert.equal(settled(), false, 'Editor completes before the required observed prefix wait')
    await pause(10)
  }
  throw new Error('No editor-to-prefix blocking edge observed')
}
async function observeCycle(a, b, settled) {
  let observed = null
  const until = Date.now() + 3000
  while (Date.now() < until && !settled()) {
    const rows = JSON.parse(await root.query(waitsSql(a, b)))
    if (rows.some(row => row.pid === a && row.blockers.includes(b)) && rows.some(row => row.pid === b && row.blockers.includes(a))) {
      observed = rows; break
    }
    await pause(10)
  }
  return observed
}
async function race(kind, outcome) {
  const f = await fixture(kind, outcome), a = open(`${kind}-${outcome}-operation`), b = open(`${kind}-${outcome}-editor`)
  let pendingA, pendingB, doneA = false, doneB = false
  try {
    await a.query(helper); await b.query(helper)
    const aPid = Number(await a.query('SELECT pg_backend_pid();')), bPid = Number(await b.query('SELECT pg_backend_pid();'))
    const before = await state(f)
    await a.query(`BEGIN ISOLATION LEVEL READ COMMITTED; ${prefixSql(f)}`)
    pendingB = b.query(`BEGIN ISOLATION LEVEL READ COMMITTED; ${editSql(f, kind === 'trade' ? null : f.players[0])} COMMIT;`)
      .then(output => { doneB = true; return JSON.parse(output) }, error => { doneB = true; throw error })
    const first = await firstWait(aPid, bPid, () => doneB)
    assert.deepEqual(await state(f), before, 'Prefix staging changes no committed fixture row')
    print('actual-editor-prefix-wait', { kind, outcome, first })
    let resultA = null, cycle = null
    if (outcome === 'prefix-rollback') await a.query('ROLLBACK;')
    else {
      pendingA = a.query(`${operationSql(f)} COMMIT;`).then(output => { doneA = true; return JSON.parse(output) }, error => { doneA = true; throw error })
      cycle = await observeCycle(aPid, bPid, () => doneA || doneB)
      resultA = await pendingA
    }
    const resultB = await pendingB, results = [resultA, resultB].filter(Boolean)
    assert(results.every(r => !['55P03', '57014', '40001'].includes(r.sqlstate)), 'Timeout or serialization failure does not prove this deadlock')
    const deadlocks = results.filter(r => r.sqlstate === '40P01')
    if (outcome === 'prefix-rollback') {
      assert.equal(resultB.ok, true); assert.equal(deadlocks.length, 0)
      const after = await state(f)
      assert.deepEqual(after.rosters, before.rosters); assert.deepEqual(after.trades, before.trades)
      assert.deepEqual(after.balances, before.balances); assert.deepEqual(after.wire, before.wire)
      assert.deepEqual(after.transactions, before.transactions)
      assert.equal(after.claims[0].drop_player_id, kind === 'trade' ? null : f.players[0])
    } else {
      assert.equal(deadlocks.length, expectation === 'deadlock' ? 1 : 0)
      if (expectation === 'deadlock') assert(cycle, 'Require both actual pg_blocking_pids edges before 40P01')
      const after = await state(f)
      assert.deepEqual(after.balances, before.balances); assert.deepEqual(after.priorities, before.priorities)
      if (!resultA.ok) {
        assert.equal(resultA.sqlstate, '40P01')
        assert.deepEqual(after.rosters, before.rosters); assert.deepEqual(after.trades, before.trades)
        assert.deepEqual(after.wire, before.wire); assert.deepEqual(after.transactions, before.transactions)
        assert.equal(resultB.ok, true)
      }
      if (!resultB.ok && kind === 'trade') {
        assert(['40P01', 'P0002'].includes(resultB.sqlstate))
        if (resultB.sqlstate === 'P0002') {
          assert.equal(resultA.ok, true)
          assert.equal(after.claims[0].status, 'cancelled')
          assert.match(resultB.message, /Pending waiver claim not found/)
        }
      }
      if (!resultB.ok && kind === 'drop') assert(['40P01', 'P0001'].includes(resultB.sqlstate))
      // Retry only the failed branch. Never claim rollback of the successful peer.
      if (!resultA.ok) {
        const retry = JSON.parse(await a.query(`BEGIN; ${operationSql(f)} COMMIT;`))
        assert.equal(retry.ok, true); print('actual-operation-retry', { kind, retry })
      }
      if (!resultB.ok && resultB.sqlstate !== 'P0002') {
        const retry = JSON.parse(await b.query(`BEGIN; ${editSql(f, null)} COMMIT;`))
        assert.equal(retry.ok, true); print('actual-editor-retry', { kind, retry })
      }
      const final = await state(f)
      assert.equal(final.claims[0].status, kind === 'trade' ? 'cancelled' : 'pending'); assert.equal(final.claims[0].drop_player_id, null)
      if (kind === 'trade') {
        assert.equal(final.trades[0].status, 'completed')
        assert.equal(final.rosters.find(r => r.id === f.rosters[0]).member_id, f.members[1])
        assert.equal(final.rosters.find(r => r.id === f.rosters[1]).member_id, f.members[0])
        assert.equal(final.transactions.length, before.transactions.length + 4)
      } else {
        assert.equal(final.rosters.some(r => r.id === f.rosters[0]), false)
        assert.equal(final.transactions.length, before.transactions.length + 1)
        assert.equal(final.wire.filter(w => w.player_id === f.players[0]).length, 1)
      }
      print('actual-overlap-final-state', { kind, outcome, final })
    }
    assert.equal(resultB.role, 'service_role')
    if (resultA) assert.equal(resultA.role, kind === 'drop' ? 'authenticated' : 'service_role')
    if (resultA && kind === 'drop') assert.equal(resultA.subject, f.users[0])
    print('actual-overlap-result', { kind, outcome, expectation, resultA, resultB, cycle, realDeadlocks: deadlocks.length })
  } finally {
    // Close only this draft's own sessions. Their close releases all held prefix locks.
    if (!a.pending && !a.ended) await a.query('ROLLBACK;').catch(() => {})
    if (a.pending) a.child.kill('SIGTERM')
    if (pendingA) await pendingA.catch(() => {})
    if (pendingB) await pendingB.catch(() => {})
    await a.close(); await b.close()
  }
}
try {
  await root.query(helper)
  const names = ['public/edit_waiver_claim_atomic.sql','public/complete_accepted_trade_atomic.sql',
    'public/drop_player_atomic__uuid_uuid_uuid.sql','private/sync_roster_linked_state.sql','private/validate_waiver_claim_drop_player.sql']
  print('source-binding', { hashes: Object.fromEntries(names.map(name => [name,
    createHash('sha256').update(readFileSync(resolve(process.cwd(), 'supabase/sql/functions/by-name', name))).digest('hex')])) })
  const started = Date.now()
  for (const kind of ['trade', 'drop']) for (const outcome of ['prefix-commits', 'prefix-rollback']) {
    assert(Date.now() - started < 45000, 'Do not start another race after 45 seconds')
    await race(kind, outcome)
  }
} finally {
  const errors = []
  const clean = async work => { try { await work() } catch (error) { errors.push(error.message) } }
  for (const session of sessions) await clean(() => session.close())
  const cleaner = root.ended ? new Session('cleanup') : root
  for (const f of fixtures.filter(f => f.mayClean)) await clean(async () => {
    await cleaner.query(`BEGIN;
      DELETE FROM public.notification_outbox WHERE member_id IN (${list(f.members)})
        OR data->>'tradeId' IN (SELECT id::text FROM public.trades WHERE league_id=${q(f.league)});
      DELETE FROM public.league_activity WHERE league_id=${q(f.league)};
      DELETE FROM public.roster_transactions WHERE league_id=${q(f.league)};
      DELETE FROM public.trades WHERE league_id=${q(f.league)};
      DELETE FROM public.leagues WHERE id=${q(f.league)};
      DELETE FROM public.players WHERE id IN (${list(f.players)});
      DELETE FROM auth.users WHERE id IN (${list(f.users)});
      DELETE FROM private.score_input_revisions WHERE scope IN (${list(f.scopes)}); COMMIT;`)
    const remaining = JSON.parse(await cleaner.query(`SELECT jsonb_build_object(
      'users',(SELECT count(*) FROM auth.users WHERE id IN (${list(f.users)})),
      'league',(SELECT count(*) FROM public.leagues WHERE id=${q(f.league)}),
      'season',(SELECT count(*) FROM public.league_seasons WHERE id=${q(f.season)}),
      'members',(SELECT count(*) FROM public.league_members WHERE id IN (${list(f.members)})),
      'players',(SELECT count(*) FROM public.players WHERE id IN (${list(f.players)})),
      'rosters',(SELECT count(*) FROM public.roster_players WHERE id IN (${list(f.rosters)})),
      'claims',(SELECT count(*) FROM public.waiver_claims WHERE league_id=${q(f.league)}),
      'trades',(SELECT count(*) FROM public.trades WHERE league_id=${q(f.league)}),
      'wire',(SELECT count(*) FROM public.waiver_wire_log WHERE league_id=${q(f.league)}),
      'transactions',(SELECT count(*) FROM public.roster_transactions WHERE league_id=${q(f.league)}),
      'activity',(SELECT count(*) FROM public.league_activity WHERE league_id=${q(f.league)}),
      'outbox',(SELECT count(*) FROM public.notification_outbox WHERE member_id IN (${list(f.members)})),
      'revisions',(SELECT count(*) FROM private.score_input_revisions WHERE scope IN (${list(f.scopes)})));`))
    assert(Object.values(remaining).every(count => count === 0), `Own cleanup leaves rows: ${JSON.stringify(remaining)}`)
    print('actual-owned-cleanup', { kind: f.kind, outcome: f.outcome, remaining })
  })
  await clean(() => cleaner.close())
  if (cleaner !== root) await clean(() => root.close())
  print('cleanup-errors', { errors })
  if (errors.length) throw new Error(`Own cleanup fails: ${errors.join('; ')}`)
}

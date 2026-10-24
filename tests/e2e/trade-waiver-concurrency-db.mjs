// Actual isolated trade settlement, waiver priority, busy retry, and rollback regression.
import { spawn } from 'node:child_process'
import { randomUUID,createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const db = process.env.SUPABASE_DB_URL
assert(db && ['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
const expected = 'repaired'
const prefix = `owned-trade-waiver-${randomUUID()}`
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
const list = (values) => values.map(quote).join(',')
const parse = (value) => JSON.parse(value)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sessions = [], fixtures = []
const print = (stage, evidence) => console.log(JSON.stringify({ stage, ...evidence }))

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
      this.child.stdin.write(`${statement}\nSELECT ${quote(marker)};\n`)
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
const root = new Session('inspector')
const open = (name) => { const session = new Session(name); sessions.push(session); return session }


const checkout=fileURLToPath(new URL('../../',import.meta.url))
function bindSource() {
  const names=['public/process_due_waiver_claims_atomic.sql','public/process_next_waiver_claim_atomic.sql',
    'public/create_waiver_claim_atomic.sql','public/complete_accepted_trade_atomic.sql',
    'private/sync_roster_linked_state.sql','private/validate_waiver_claim_drop_player.sql']
  print('source-binding',{hashes:Object.fromEntries(names.map((name)=>[name,
    createHash('sha256').update(readFileSync(checkout+'supabase/sql/functions/by-name/'+name,'utf8')).digest('hex')]))})
}
// These invoker helpers capture real public-path errors. They add no production faults or delays.
const helpers=`CREATE FUNCTION pg_temp.capture_complete(t uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER AS $cap$ BEGIN
  PERFORM public.complete_accepted_trade_atomic(t);
  RETURN jsonb_build_object('ok',true,'role',current_user);
EXCEPTION WHEN query_canceled THEN
  RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user);
WHEN OTHERS THEN
  RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user);
END $cap$;
CREATE FUNCTION pg_temp.capture_waiver(d date) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER AS $cap$ DECLARE rows jsonb; BEGIN
  SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]') INTO rows
    FROM public.process_due_waiver_claims_atomic(d,1) r;
  RETURN jsonb_build_object('ok',true,'rows',rows,'role',current_user);
EXCEPTION WHEN query_canceled THEN
  RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user);
WHEN OTHERS THEN
  RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user);
END $cap$;
CREATE FUNCTION pg_temp.inspect_claim_lock(c uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER AS $cap$ BEGIN
  PERFORM 1 FROM public.waiver_claims WHERE id=c FOR UPDATE NOWAIT;
  RETURN jsonb_build_object('available',true);
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('available',false,'sqlstate',SQLSTATE);
END $cap$;
GRANT EXECUTE ON FUNCTION pg_temp.capture_complete(uuid),pg_temp.capture_waiver(date) TO service_role;
DO $g$ BEGIN EXECUTE format('GRANT USAGE ON SCHEMA %I TO service_role',
  (SELECT nspname FROM pg_namespace WHERE oid=pg_my_temp_schema())); END $g$;`

async function fixture(control) {
  const f={control,league:randomUUID(),season:randomUUID(),users:Array.from({length:3},()=>randomUUID()),
    members:Array.from({length:3},()=>randomUUID()),players:Array.from({length:3},()=>randomUUID()),
    rosters:Array.from({length:3},()=>randomUUID()),claims:[],claim:null,trade:null,wire:null,mayClean:false,
    processDate:'1900-01-03'}
  f.scopes=[`league:${f.league}`,`season:${f.season}`,...f.players.map((id)=>`player:${id}`)]
  fixtures.push(f)
  assert.equal(await root.query(`SELECT
    (SELECT count(*) FROM auth.users WHERE id IN (${list(f.users)}))
    +(SELECT count(*) FROM public.leagues WHERE id=${quote(f.league)})
    +(SELECT count(*) FROM public.league_seasons WHERE id=${quote(f.season)})
    +(SELECT count(*) FROM public.league_members WHERE id IN (${list(f.members)}))
    +(SELECT count(*) FROM public.players WHERE id IN (${list(f.players)}))
    +(SELECT count(*) FROM public.roster_players WHERE id IN (${list(f.rosters)}))
    +(SELECT count(*) FROM private.score_input_revisions WHERE scope IN (${list(f.scopes)}));`),'0')
  f.mayClean=true
  await root.query(`BEGIN;
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,
      raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      SELECT id,'authenticated','authenticated',id||'@example.test','x',now(),'{}','{}',now(),now()
      FROM unnest(ARRAY[${list(f.users)}]::uuid[]) id;
    INSERT INTO public.leagues(id,name,slug,commissioner_id,status,waiver_mode,trade_deadline,
      trade_veto_mode,trade_veto_window_hours,roster_size,weekly_add_limit)
      VALUES(${quote(f.league)},'Owned trade waiver overlap',${quote(f.league)},${quote(f.users[0])},
        'active','faab',NULL,'member_vote',24,20,NULL);
    INSERT INTO public.league_members(id,league_id,user_id,role,team_name)
      SELECT m,${quote(f.league)},u,(CASE WHEN n=1 THEN 'commissioner' ELSE 'manager' END)::public.league_member_role,
        'Owned '||n FROM unnest(ARRAY[${list(f.members)}]::uuid[],ARRAY[${list(f.users)}]::uuid[])
        WITH ORDINALITY t(m,u,n);
    INSERT INTO public.league_seasons(id,league_id,season_year,is_current)
      VALUES(${quote(f.season)},${quote(f.league)},2164,true);
    INSERT INTO public.waiver_priorities(league_id,league_season_id,member_id,priority)
      SELECT ${quote(f.league)},${quote(f.season)},id,n::int FROM unnest(ARRAY[${list(f.members)}]::uuid[])
      WITH ORDINALITY t(id,n);
    INSERT INTO public.faab_balances(league_id,league_season_id,member_id,balance)
      SELECT ${quote(f.league)},${quote(f.season)},id,100 FROM unnest(ARRAY[${list(f.members)}]::uuid[]) id
      ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET balance=100;
    INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team,years_exp)
      SELECT id,'Synthetic',id::text,'PG',ARRAY['PG'],NULL,2 FROM unnest(ARRAY[${list(f.players)}]::uuid[]) id;
    INSERT INTO public.roster_players(id,player_id,member_id,league_id,league_season_id,acquired_via,is_on_ir,is_on_taxi)
      SELECT r,p,m,${quote(f.league)},${quote(f.season)},'draft',false,false
      FROM unnest(ARRAY[${list(f.rosters)}]::uuid[],ARRAY[${list(f.players)}]::uuid[],
        ARRAY[${list(f.members)}]::uuid[]) t(r,p,m);
    COMMIT;`)
  // The real public drop checks its actual authenticated identity. Player Q has no NBA team/slate.
  await root.query(`BEGIN; SET LOCAL ROLE authenticated;
    SELECT set_config('request.jwt.claim.sub',${quote(f.users[2])},true);
    SELECT public.drop_player_atomic(${quote(f.rosters[2])},${quote(f.season)},NULL::uuid); COMMIT;`)
  f.wire=await root.query(`SELECT id FROM public.waiver_wire_log
    WHERE league_id=${quote(f.league)} AND player_id=${quote(f.players[2])} AND cleared_at IS NULL;`)
  assert.match(f.wire,/^[0-9a-f-]{36}$/)
  // Explicit own fixture clock metadata. The actual claim RPC derives its process date from this log.
  await root.query(`UPDATE public.waiver_wire_log SET placed_on_waivers_at='1900-01-01 12:00:00+00',
    clears_at='1900-01-03 12:00:00+00' WHERE id=${quote(f.wire)};`)
  f.claim=await root.query(`BEGIN; SET LOCAL ROLE service_role;
    SELECT public.create_waiver_claim_atomic(${quote(f.league)},${quote(f.members[0])},${quote(f.players[2])},
      ${quote(f.players[0])},${quote(f.users[0])},0,1); COMMIT;`)
  assert.match(f.claim,/^[0-9a-f-]{36}$/); f.claims.push(f.claim)
  f.lower=await root.query(`BEGIN; SET LOCAL ROLE service_role;
    SELECT public.create_waiver_claim_atomic(${quote(f.league)},${quote(f.members[2])},${quote(f.players[2])},
      NULL::uuid,${quote(f.users[2])},0,1); COMMIT;`)
  assert.match(f.lower,/^[0-9a-f-]{36}$/); f.claims.push(f.lower)
  const expires=new Date(Date.now()+86400000).toISOString()
  f.trade=await root.query(`BEGIN; SET LOCAL ROLE service_role;
    SELECT public.propose_trade_atomic(${quote(f.league)},${quote(f.season)},
      ${quote(f.members[0])},${quote(f.members[1])},
      ARRAY[${quote(f.players[0])}]::uuid[],ARRAY[${quote(f.players[1])}]::uuid[],
      ARRAY[]::uuid[],ARRAY[]::uuid[],'Owned accepted player exchange',${quote(expires)}::timestamptz,0,0); COMMIT;`)
  assert.match(f.trade,/^[0-9a-f-]{36}$/)
  const accept=parse(await root.query(`BEGIN; SET LOCAL ROLE service_role;
    SELECT public.accept_trade_atomic(${quote(f.trade)},${quote(f.members[1])}); COMMIT;`))
  assert.equal(accept.allAccepted,true); assert.equal(accept.expired,false)
  await root.query(`UPDATE public.trades SET veto_window_expires_at=clock_timestamp()-interval '1 second'
    WHERE id=${quote(f.trade)} AND status='accepted';`)
  assert.equal(await root.query(`SELECT c.status='pending' AND c.drop_player_id=${quote(f.players[0])}
    AND c.submitted_at<=t.accepted_at AND c.process_date=${quote(f.processDate)}::date
    AND t.status='accepted' AND t.veto_window_expires_at<now()
    FROM public.waiver_claims c JOIN public.trades t ON t.id=${quote(f.trade)} WHERE c.id=${quote(f.claim)};`),'t')
  return f
}
const stateSql=(f)=>`SELECT jsonb_build_object(
  'trade',(SELECT to_jsonb(t) FROM public.trades t WHERE id=${quote(f.trade)}),
  'claims',(SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM public.waiver_claims c WHERE league_id=${quote(f.league)}),
  'rosters',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.roster_players r WHERE league_id=${quote(f.league)}),
  'wire',(SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY id),'[]') FROM public.waiver_wire_log w WHERE league_id=${quote(f.league)}),
  'balances',(SELECT jsonb_agg(to_jsonb(b) ORDER BY member_id) FROM public.faab_balances b WHERE league_id=${quote(f.league)}),
  'priorities',(SELECT jsonb_agg(to_jsonb(p) ORDER BY member_id) FROM public.waiver_priorities p WHERE league_id=${quote(f.league)}),
  'transactions',(SELECT count(*) FROM public.roster_transactions WHERE league_id=${quote(f.league)}),
  'activity',(SELECT count(*) FROM public.league_activity WHERE league_id=${quote(f.league)}));`
// Require ALL globally eligible claims at this date to be the two owned pending claims.
// This is stronger than checking only the head: the processor can try-lock and skip busy leagues.
const eligibleSql=(f)=>`SELECT c.id FROM public.waiver_claims c
  JOIN public.waiver_wire_log w ON w.league_id=c.league_id AND w.league_season_id=c.league_season_id
    AND w.player_id=c.player_id AND w.cleared_at IS NULL AND w.clears_at<=now()
  JOIN public.leagues l ON l.id=c.league_id AND l.status IN ('active','playoffs','offseason')
  JOIN public.league_seasons s ON s.id=c.league_season_id AND s.is_current=true
  WHERE c.status='pending' AND c.process_date<=${quote(f.processDate)}::date`
async function prepareWaiver(w,f,claimIds=[f.claim,f.lower]) {
  const found=parse(await w.query(`BEGIN ISOLATION LEVEL REPEATABLE READ;
    DO $own$ BEGIN
      IF NOT pg_try_advisory_xact_lock(hashtext(${quote(f.league)}),hashtext(${quote(f.season)})) THEN
        RAISE EXCEPTION 'Own waiver batch is busy; abort without other league locks';
      END IF;
    END $own$;
    SELECT COALESCE(jsonb_agg(DISTINCT id ORDER BY id),'[]') FROM (${eligibleSql(f)}) eligible;`))
  assert.deepEqual(found,[...claimIds].sort(),'Abort: every eligible global claim must be an own pending claim')
  print('exact-own-waiver-candidates',{control:f.control,ids:found})
}
const waiverCall=(f,claimIds=[f.claim,f.lower])=>`DO $guard$ DECLARE got uuid[]; BEGIN
  SELECT array_agg(DISTINCT id ORDER BY id) INTO got FROM (${eligibleSql(f)}) eligible;
  IF got IS DISTINCT FROM ARRAY[${list([...claimIds].sort())}]::uuid[] THEN
    RAISE EXCEPTION 'Abort: global waiver candidates changed outside owned claim';
  END IF;
END $guard$;
SET LOCAL ROLE service_role;
SELECT pg_temp.capture_waiver(${quote(f.processDate)}::date);
COMMIT;`
async function waitOn(pid,blocker,f,settled=()=>false) {
  const deadline=Date.now()+6000
  while(Date.now()<deadline) {
    if(settled()) return {settled:true}
    const r=parse(await root.query(`SELECT jsonb_build_object('pid',${pid},'blocker',${blocker},
      'waitType',a.wait_event_type,'waitEvent',a.wait_event,'blockers',pg_blocking_pids(a.pid),
      'waitsOnOwn',${blocker}=ANY(pg_blocking_pids(a.pid)),
      'memberKeyWait',(SELECT EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=${pid}
        AND NOT l.granted AND l.locktype='advisory' AND l.objsubid=2
        AND l.classid::bigint=(hashtext(${quote(f.league)})::bigint & 4294967295)
        AND l.objid::bigint=(hashtext(${quote(f.members[0])})::bigint & 4294967295))))
      FROM pg_stat_activity a WHERE a.pid=${pid};`))
    if(r.waitType==='Lock' && r.waitsOnOwn) return r
    await sleep(25)
  }
  throw new Error('Actual own statement does not enter the expected wait')
}
async function retryWaiver(f) {
  const w=open(f.control+'-retry-waiver'); await w.query(helpers)
  try {
    await prepareWaiver(w,f,[f.lower])
    const r=parse(await w.query(waiverCall(f,[f.lower])))
    assert.equal(r.ok,true); assert.equal(r.rows.length,1)
    assert.equal(r.rows[0].claim_id,f.lower)
    assert.equal(r.rows[0].status,'succeeded')
    return r
  } finally {await w.close()}
}
function assertComplete(s,f) {
  assert.equal(s.trade.status,'completed'); assert.ok(s.trade.completed_at)
  assert.equal(s.rosters.find((r)=>r.player_id===f.players[0]).member_id,f.members[1])
  assert.equal(s.rosters.find((r)=>r.player_id===f.players[1]).member_id,f.members[0])
}

try {
  bindSource(); await root.query(helpers)
  for(const control of ['completion-waiver-overlap','waiting-waiver-rolls-back','uncontended-positive']) {
    const f=await fixture(control),c=open(control+'-completion'),w=open(control+'-waiver'),barrier=open(control+'-roster-barrier')
    await c.query(helpers); await w.query(helpers)
    const cPid=Number(await c.query('SELECT pg_backend_pid();')),wPid=Number(await w.query('SELECT pg_backend_pid();'))
    const barrierPid=Number(await barrier.query('SELECT pg_backend_pid();'))
    const before=parse(await root.query(stateSql(f)))
    let pendingC,pendingW,resultC,resultW,wSettled=false
    try {
      if(control==='uncontended-positive') {
        resultC=parse(await c.query(`BEGIN; SET LOCAL ROLE service_role;
          SELECT pg_temp.capture_complete(${quote(f.trade)}); COMMIT;`))
        assert.equal(resultC.ok,true)
        const completed=parse(await root.query(stateSql(f))); assertComplete(completed,f)
        assert.equal(completed.claims.find((r)=>r.id===f.claim).drop_player_id,null)
        resultW=await retryWaiver(f)
      } else {
        assert.equal(await barrier.query(`BEGIN; SELECT id FROM public.roster_players
          WHERE id=${quote(f.rosters[0])} FOR UPDATE;`),f.rosters[0])
        pendingC=c.query(`BEGIN; SET LOCAL ROLE service_role;
          SELECT pg_temp.capture_complete(${quote(f.trade)}); COMMIT;`)
          .then((output)=>({output}),(error)=>({error}))
        const completionWait=await waitOn(cPid,barrierPid,f)
        await prepareWaiver(w,f)
        pendingW=w.query(waiverCall(f)).then((output)=>{wSettled=true;return {output}},
          (error)=>{wSettled=true;return {error}})
        const waiverWait=await waitOn(wPid,cPid,f,()=>wSettled)
        if(!waiverWait.settled) assert.equal(waiverWait.memberKeyWait,true,
          'Processor waits on exact original owner member key')
        if(waiverWait.settled) {
          assert.equal(expected,'repaired')
          const early=await pendingW; if('error' in early) throw early.error
          resultW=parse(early.output); assert.equal(resultW.ok,true)
          assert.equal(resultW.rows.length,0,'Busy own league defers without awarding another claim')
        }
        const claimLock=parse(await root.query(`BEGIN;
          SELECT pg_temp.inspect_claim_lock(${quote(f.claim)}); ROLLBACK;`))
        assert.equal(claimLock.available,true,'Busy processor must release its pending claim lock')
        print('actual-completion-and-waiver-waits',{expected,control,completionWait,waiverWait,claimLock})
        assert.deepEqual(parse(await root.query(stateSql(f))),before)
        if(control==='waiting-waiver-rolls-back') {
          if(!waiverWait.settled) {
            assert.equal(await root.query(`SELECT pg_cancel_backend(${wPid});`),'t')
            const cancelled=await pendingW
            if('error' in cancelled) throw cancelled.error
            resultW=parse(cancelled.output); assert.equal(resultW.sqlstate,'57014')
          }
          // capture_waiver rolls back its call; COMMIT releases own guard batch key.
          assert.deepEqual(parse(await root.query(stateSql(f))),before)
          await barrier.query('ROLLBACK;')
          const done=await pendingC; if('error' in done) throw done.error
          resultC=parse(done.output); assert.equal(resultC.ok,true)
          const completed=parse(await root.query(stateSql(f))); assertComplete(completed,f)
          assert.equal(completed.claims.find((r)=>r.id===f.claim).drop_player_id,null)
          resultW=await retryWaiver(f)
          print('actual-waiver-rollback-control',{resultC,resultW,ownCancellation:!waiverWait.settled,
            earlyBusyDeferral:Boolean(waiverWait.settled)})
        } else {
          await barrier.query('ROLLBACK;')
          const done=await Promise.all([pendingC,pendingW])
          if('error' in done[0]) throw done[0].error
          if('error' in done[1]) throw done[1].error
          resultC=parse(done[0].output); resultW=parse(done[1].output)
          const results=[resultC,resultW]
          assert(results.every((r)=>!['55P03','57014'].includes(r.sqlstate)),'Timeout never proves this deadlock')
          const deadlocks=results.filter((r)=>r.sqlstate==='40P01').length
          {
            assert.equal(deadlocks,0); assert.equal(resultC.ok,true)
            if(!resultW.ok) assert.equal(resultW.sqlstate,'40001','Only a real snapshot change permits a repaired retry')
          }
          if(resultW.ok) {
            if(resultW.rows.length===0) assert.equal(expected,'repaired','Only repaired busy deferral may return no claim')
            else {
              assert.equal(resultW.rows.length,1)
              assert.equal(resultW.rows[0].claim_id,f.lower)
              assert.equal(resultW.rows[0].status,'succeeded')
            }
          }
          print('actual-trade-waiver-result',{expected,resultC,resultW})
          if(!resultW.ok || resultW.rows.length===0) {
            if(!resultW.ok) assert(['40P01','40001'].includes(resultW.sqlstate))
            const completed=parse(await root.query(stateSql(f))); assertComplete(completed,f)
            assert.equal(completed.claims.find((r)=>r.id===f.claim).status,'cancelled')
            assert.equal(completed.claims.find((r)=>r.id===f.claim).drop_player_id,null)
            resultW=await retryWaiver(f)
          }
        }
      }
      const after=parse(await root.query(stateSql(f))); assertComplete(after,f)
      const finalClaim=after.claims.find((r)=>r.id===f.claim)
      assert.equal(finalClaim.status,'cancelled')
      assert.ok(finalClaim.processed_at)
      assert.match(finalClaim.failure_reason,/selected drop player left/); assert.equal(finalClaim.drop_player_id,null)
      assert.equal(after.claims.find((r)=>r.id===f.lower).status,'succeeded',
        'Only the remaining eligible claim wins after settlement cancels the traded drop')
      assert.equal(after.rosters.length,3)
      assert.equal(after.rosters.find((r)=>r.player_id===f.players[2]).member_id,f.members[2])
      assert(after.rosters.every((r)=>!r.is_on_ir && !r.is_on_taxi))
      assert(after.balances.every((r)=>r.balance===100))
      assert.ok(after.wire.find((r)=>r.id===f.wire).cleared_at)
      assert.equal(after.wire.find((r)=>r.id===f.wire).claimed_by_claim_id,f.lower)
      assert.equal(after.transactions,6,'One actual initial drop, four trade rows, one waiver add')
      print('actual-trade-waiver-final',{expected,control,after})
    } finally {
      if(!barrier.ended && !barrier.pending) await barrier.query('ROLLBACK;').catch(()=>{})
      if(pendingC) await pendingC
      if(!c.ended && !c.pending) await c.query('ROLLBACK;').catch(()=>{})
      if(pendingW) await pendingW
      await c.close(); await w.close(); await barrier.close()
    }
  }
} finally {
  const errors=[],clean=async(work)=>{try{await work()}catch(error){errors.push(error.message)}}
  for(const s of sessions) await clean(()=>s.close())
  const cleaner=root.ended?new Session('cleanup'):root
  for(const f of fixtures.filter((f)=>f.mayClean)) await clean(async()=>{
    const trades=parse(await cleaner.query(`SELECT COALESCE(jsonb_agg(id),'[]') FROM public.trades WHERE league_id=${quote(f.league)};`))
    const claims=parse(await cleaner.query(`SELECT COALESCE(jsonb_agg(id),'[]') FROM public.waiver_claims WHERE league_id=${quote(f.league)};`))
    await cleaner.query(`BEGIN;
      DELETE FROM public.notification_outbox WHERE member_id IN (${list(f.members)})
        ${trades.length?`OR data->>'tradeId' IN (${list(trades)})`:''}
        ${claims.length?`OR data->>'claimId' IN (${list(claims)})`:''};
      DELETE FROM public.league_activity WHERE league_id=${quote(f.league)};
      DELETE FROM public.roster_transactions WHERE league_id=${quote(f.league)};
      DELETE FROM public.waiver_wire_log WHERE league_id=${quote(f.league)};
      DELETE FROM public.waiver_claims WHERE league_id=${quote(f.league)};
      DELETE FROM public.waiver_priorities WHERE league_id=${quote(f.league)};
      DELETE FROM public.weekly_add_counts WHERE league_id=${quote(f.league)};
      ${trades.length?`DELETE FROM public.trades WHERE id IN (${list(trades)});`:''}
      DELETE FROM public.leagues WHERE id=${quote(f.league)};
      DELETE FROM public.players WHERE id IN (${list(f.players)});
      DELETE FROM auth.users WHERE id IN (${list(f.users)}); COMMIT;
      DELETE FROM private.score_input_revisions WHERE scope IN (${list(f.scopes)});`)
    const remaining=parse(await cleaner.query(`SELECT jsonb_build_object(
      'users',(SELECT count(*) FROM auth.users WHERE id IN (${list(f.users)})),
      'league',(SELECT count(*) FROM public.leagues WHERE id=${quote(f.league)}),
      'season',(SELECT count(*) FROM public.league_seasons WHERE id=${quote(f.season)}),
      'members',(SELECT count(*) FROM public.league_members WHERE id IN (${list(f.members)})),
      'players',(SELECT count(*) FROM public.players WHERE id IN (${list(f.players)})),
      'rosters',(SELECT count(*) FROM public.roster_players WHERE league_id=${quote(f.league)}),
      'trades',(SELECT count(*) FROM public.trades WHERE league_id=${quote(f.league)}),
      'claims',(SELECT count(*) FROM public.waiver_claims WHERE league_id=${quote(f.league)}),
      'wire',(SELECT count(*) FROM public.waiver_wire_log WHERE league_id=${quote(f.league)}),
      'priorities',(SELECT count(*) FROM public.waiver_priorities WHERE league_id=${quote(f.league)}),
      'weeklyAdds',(SELECT count(*) FROM public.weekly_add_counts WHERE league_id=${quote(f.league)}),
      'balances',(SELECT count(*) FROM public.faab_balances WHERE league_id=${quote(f.league)}),
      'transactions',(SELECT count(*) FROM public.roster_transactions WHERE league_id=${quote(f.league)}),
      'activity',(SELECT count(*) FROM public.league_activity WHERE league_id=${quote(f.league)}),
      'outbox',(SELECT count(*) FROM public.notification_outbox WHERE member_id IN (${list(f.members)})),
      'revisions',(SELECT count(*) FROM private.score_input_revisions WHERE scope IN (${list(f.scopes)})));`))
    assert(Object.values(remaining).every((n)=>n===0),`Own cleanup leaves rows: ${JSON.stringify(remaining)}`)
    print('actual-owned-cleanup',{control:f.control,remaining})
  })
  await clean(()=>cleaner.close()); if(cleaner!==root) await clean(()=>root.close())
  print('cleanup-errors',{errors}); if(errors.length) throw new Error(errors.join('; '))
}

// Actual isolated trade settlement, waiver priority, busy retry, and rollback regression.
import { spawn } from 'node:child_process'
import { randomUUID,createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const db = process.env.SUPABASE_DB_URL
assert(db && ['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
const expected = process.argv.find(a=>a.startsWith('--expect='))?.split('=')[1] ?? 'clean'
assert(['deadlock','clean'].includes(expected))
const prefix = `owned-cross-league-${randomUUID()}`
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


// Own-fixture regression. Refuses non-local database targets.
// No production function, trigger, or result is replaced.
const checkout = fileURLToPath(new URL('../../', import.meta.url))
const definitions = [
  'public.process_due_accepted_trades_atomic(integer)',
  'public.complete_accepted_trade_atomic(uuid)',
  'public.process_due_waiver_claims_atomic(date,integer)',
  'public.process_next_waiver_claim_atomic(date)',
  'private.ensure_faab_balance(uuid,uuid,uuid)',
]
const helpers = `CREATE FUNCTION pg_temp.capture_batch(d date) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER AS $cap$ DECLARE rows jsonb; BEGIN
  SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]') INTO rows
    FROM public.process_due_waiver_claims_atomic(d,2) r;
  RETURN jsonb_build_object('ok',true,'rows',rows,'role',current_user);
EXCEPTION WHEN query_canceled THEN
  RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user);
WHEN OTHERS THEN
  RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user);
END $cap$;
GRANT EXECUTE ON FUNCTION pg_temp.capture_batch(date) TO service_role;
DO $g$ BEGIN EXECUTE format('GRANT USAGE ON SCHEMA %I TO service_role',
  (SELECT nspname FROM pg_namespace WHERE oid=pg_my_temp_schema())); END $g$;`
const queueCandidates = (limit=2) => `SELECT t.id FROM public.trades t
  JOIN public.league_seasons s ON s.id=t.league_season_id
  JOIN public.leagues l ON l.id=t.league_id
  WHERE t.status='accepted' AND t.veto_window_expires_at<=now() AND s.is_current=true
    AND l.status IN ('active','playoffs','offseason')
  ORDER BY t.veto_window_expires_at,t.proposed_at,t.id LIMIT ${limit}`
const waiverCandidates = (f) => `SELECT c.id FROM public.waiver_claims c
  JOIN public.waiver_wire_log w ON w.league_id=c.league_id AND w.league_season_id=c.league_season_id
    AND w.player_id=c.player_id AND w.cleared_at IS NULL AND w.clears_at<=now()
  JOIN public.leagues l ON l.id=c.league_id AND l.status IN ('active','playoffs','offseason')
  JOIN public.league_seasons s ON s.id=c.league_season_id AND s.is_current=true
  WHERE c.status='pending' AND c.process_date<=${quote(f.processDate)}::date`
const orderedArrayGuard = (sql,ids,label) => `DO $guard$ DECLARE got uuid[]; BEGIN
  SELECT array_agg(id) INTO got FROM (${sql}) own_candidates;
  IF got IS DISTINCT FROM ARRAY[${list(ids)}]::uuid[] THEN
    RAISE EXCEPTION '${label}: candidate set includes or replaces an owned row';
  END IF; END $guard$;`
async function prepareQueue(q,f,ids=f.tradeOrder) {
  await q.query(`BEGIN ISOLATION LEVEL REPEATABLE READ;
    SELECT id FROM public.trades WHERE id IN (${list(ids)}) ORDER BY id FOR UPDATE NOWAIT;`)
  const found=parse(await q.query(`SELECT COALESCE(jsonb_agg(id),'[]') FROM (${queueCandidates(ids.length)}) candidates;`))
  assert.deepEqual(found,ids,'Abort: global first two trade candidates must be exactly owned, in order')
  await q.query(orderedArrayGuard(queueCandidates(ids.length),ids,'Trade queue isolation'))
  print('exact-owned-trade-queue',{control:f.control,ids:found,unrelatedResourcesLocked:false})
}
async function prepareWaiver(w,f,ids=f.claims) {
  await w.query(`BEGIN ISOLATION LEVEL REPEATABLE READ;
    DO $own$ BEGIN
      ${f.parts.map(p=>`IF NOT pg_try_advisory_xact_lock(hashtext(${quote(p.league)}),hashtext(${quote(p.season)})) THEN
        RAISE EXCEPTION 'Own waiver fixture is busy'; END IF;`).join('\n')}
    END $own$;`)
  const found=parse(await w.query(`SELECT COALESCE(jsonb_agg(DISTINCT id ORDER BY id),'[]')
    FROM (${waiverCandidates(f)}) candidates;`))
  assert.deepEqual(found,[...ids].sort(),'Abort: ALL globally eligible waiver claims at cutoff must be owned')
  const sortedSql=`SELECT DISTINCT id FROM (${waiverCandidates(f)}) candidates ORDER BY id`
  await w.query(orderedArrayGuard(sortedSql,[...ids].sort(),'Waiver isolation'))
  print('exact-owned-waiver-queue',{control:f.control,ids:found,unrelatedResourcesLocked:false})
}
const queueCall = (f,commit=true,limit=2) => `SET LOCAL ROLE service_role;
  SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]') FROM public.process_due_accepted_trades_atomic(${limit}) r;
  ${commit?'COMMIT;':''}`
const waiverCall = (f,commit=true) => `SET LOCAL ROLE service_role;
  SELECT pg_temp.capture_batch(${quote(f.processDate)}::date); ${commit?'COMMIT;':''}`
async function fixture(control) {
  const f={control,parts:[],tradeOrder:[],claims:[],processDate:'1900-01-04'}
  fixtures.push(f)
  for(let index=0;index<2;index++) {
    const p={league:randomUUID(),season:randomUUID(),users:Array.from({length:4},()=>randomUUID()),
      members:Array.from({length:4},()=>randomUUID()),player:randomUUID(),roster:randomUUID(),mayClean:false}
    p.scopes=[`league:${p.league}`,`season:${p.season}`,`player:${p.player}`]
    f.parts.push(p)
    assert.equal(await root.query(`SELECT
      (SELECT count(*) FROM auth.users WHERE id IN (${list(p.users)}))
      +(SELECT count(*) FROM public.leagues WHERE id=${quote(p.league)})
      +(SELECT count(*) FROM public.league_seasons WHERE id=${quote(p.season)})
      +(SELECT count(*) FROM public.league_members WHERE id IN (${list(p.members)}))
      +(SELECT count(*) FROM public.players WHERE id=${quote(p.player)})
      +(SELECT count(*) FROM public.roster_players WHERE id=${quote(p.roster)})
      +(SELECT count(*) FROM private.score_input_revisions WHERE scope IN (${list(p.scopes)}));`),'0')
    p.mayClean=true
    await root.query(`BEGIN;
      INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,
        raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      SELECT id,'authenticated','authenticated',id||'@example.test','x',now(),'{}','{}',now(),now()
      FROM unnest(ARRAY[${list(p.users)}]::uuid[]) id;
      INSERT INTO public.leagues(id,name,slug,commissioner_id,status,waiver_mode,trade_deadline,
        trade_veto_mode,trade_veto_window_hours,roster_size,weekly_add_limit)
      VALUES(${quote(p.league)},'Owned cross league cycle',${quote(p.league)},${quote(p.users[0])},
        'active','faab',NULL,'member_vote',24,20,NULL);
      INSERT INTO public.league_members(id,league_id,user_id,role,team_name)
      SELECT m,${quote(p.league)},u,(CASE WHEN n=1 THEN 'commissioner' ELSE 'manager' END)::public.league_member_role,
        'Owned '||n FROM unnest(ARRAY[${list(p.members)}]::uuid[],ARRAY[${list(p.users)}]::uuid[])
        WITH ORDINALITY t(m,u,n);
      INSERT INTO public.league_seasons(id,league_id,season_year,is_current)
      VALUES(${quote(p.season)},${quote(p.league)},2166,true);
      INSERT INTO public.waiver_priorities(league_id,league_season_id,member_id,priority)
      SELECT ${quote(p.league)},${quote(p.season)},id,n::int
        FROM unnest(ARRAY[${list(p.members)}]::uuid[]) WITH ORDINALITY t(id,n);
      INSERT INTO public.faab_balances(league_id,league_season_id,member_id,balance)
      SELECT ${quote(p.league)},${quote(p.season)},id,100 FROM unnest(ARRAY[${list(p.members)}]::uuid[]) id
      ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET balance=100;
      INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team,years_exp)
      VALUES(${quote(p.player)},'Synthetic',${quote(p.player)},'PG',ARRAY['PG'],NULL,2);
      INSERT INTO public.roster_players(id,player_id,member_id,league_id,league_season_id,acquired_via)
      VALUES(${quote(p.roster)},${quote(p.player)},${quote(p.members[3])},${quote(p.league)},${quote(p.season)},'draft');
      COMMIT;`)
    await root.query(`BEGIN; SET LOCAL ROLE authenticated;
      SELECT set_config('request.jwt.claim.sub',${quote(p.users[3])},true);
      SELECT public.drop_player_atomic(${quote(p.roster)},${quote(p.season)},NULL::uuid); COMMIT;`)
    p.wire=await root.query(`SELECT id FROM public.waiver_wire_log WHERE league_id=${quote(p.league)}
      AND player_id=${quote(p.player)} AND cleared_at IS NULL;`)
    assert.match(p.wire,/^[0-9a-f-]{36}$/)
    p.date=index===0?'1900-01-03':'1900-01-04'
    await root.query(`UPDATE public.waiver_wire_log SET placed_on_waivers_at=(${quote(p.date)}::date-2+time '02:00') AT TIME ZONE 'America/New_York',
      clears_at=(${quote(p.date)}::date+time '02:00') AT TIME ZONE 'America/New_York' WHERE id=${quote(p.wire)};`)
    p.claim=await root.query(`BEGIN; SET LOCAL ROLE service_role;
      SELECT public.create_waiver_claim_atomic(${quote(p.league)},${quote(p.members[2])},${quote(p.player)},
        NULL::uuid,${quote(p.users[2])},0,1); COMMIT;`)
    assert.match(p.claim,/^[0-9a-f-]{36}$/); f.claims.push(p.claim)
    assert.equal(await root.query(`SELECT process_date >= (now() AT TIME ZONE 'America/New_York')::date AND status='pending'
      FROM public.waiver_claims WHERE id=${quote(p.claim)};`),'t')
    await root.query(`UPDATE public.waiver_claims SET process_date=${quote(p.date)}::date WHERE id=${quote(p.claim)};`)
    print('owned-historical-queue-fixture',{claim:p.claim,processDate:p.date,scope:'Synthetic past-due state after a real claim submission; schedule timing is checked separately'})
    assert.equal(await root.query(`SELECT process_date=${quote(p.date)}::date AND status='pending'
      FROM public.waiver_claims WHERE id=${quote(p.claim)};`),'t')
    const expires=new Date(Date.now()+86400000).toISOString()
    p.trade=await root.query(`BEGIN; SET LOCAL ROLE service_role;
      SELECT public.propose_trade_atomic(${quote(p.league)},${quote(p.season)},
        ${quote(p.members[0])},${quote(p.members[1])},ARRAY[]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],
        'Owned accepted FAAB exchange',${quote(expires)}::timestamptz,1,2); COMMIT;`)
    assert.match(p.trade,/^[0-9a-f-]{36}$/)
    const accepted=parse(await root.query(`BEGIN; SET LOCAL ROLE service_role;
      SELECT public.accept_trade_atomic(${quote(p.trade)},${quote(p.members[1])}); COMMIT;`))
    assert.equal(accepted.allAccepted,true); assert.equal(accepted.expired,false)
    await root.query(`UPDATE public.trades SET veto_window_expires_at=${quote(index===0?'1900-01-02':'1900-01-01')}::timestamptz
      WHERE id=${quote(p.trade)} AND status='accepted';`)
  }
  f.tradeOrder=[f.parts[1].trade,f.parts[0].trade]
  return f
}
const stateSql=(f)=>`SELECT jsonb_build_object(
  'trades',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.trades t WHERE league_id IN (${list(f.parts.map(p=>p.league))})),
  'claims',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.waiver_claims c WHERE league_id IN (${list(f.parts.map(p=>p.league))})),
  'wire',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM public.waiver_wire_log w WHERE league_id IN (${list(f.parts.map(p=>p.league))})),
  'rosters',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.roster_players r WHERE league_id IN (${list(f.parts.map(p=>p.league))})),
  'balances',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM public.faab_balances b WHERE league_id IN (${list(f.parts.map(p=>p.league))})),
  'transactions',(SELECT count(*) FROM public.roster_transactions WHERE league_id IN (${list(f.parts.map(p=>p.league))})),
  'activity',(SELECT count(*) FROM public.league_activity WHERE league_id IN (${list(f.parts.map(p=>p.league))})));`
async function waitOn(pid,blocker,description) {
  const deadline=Date.now()+6000
  while(Date.now()<deadline) {
    const found=parse(await root.query(`SELECT jsonb_build_object('pid',a.pid,'blockers',pg_blocking_pids(a.pid),
      'waitType',a.wait_event_type,'waitEvent',a.wait_event)
      FROM pg_stat_activity a WHERE a.pid=${pid};`))
    if(found.waitType==='Lock' && found.blockers.includes(blocker)) {
      assert.equal(found.waitEvent,'transactionid','Expected actual row wait, not a team advisory wait')
      print('actual-owned-wait',{description,...found}); return found
    }
    await sleep(25)
  }
  throw new Error('Expected owned wait not observed: '+description)
}
async function lockBalance(b,p,member) {
  assert.equal(await b.query(`BEGIN; SELECT balance FROM public.faab_balances
    WHERE league_id=${quote(p.league)} AND league_season_id=${quote(p.season)}
      AND member_id=${quote(member)} FOR UPDATE;`),'100')
}
async function release(b) { if(!b.ended && !b.pending) await b.query('ROLLBACK;') }
const unwrap = (r) => { if('error' in r) throw r.error; return parse(r.output) }
async function runQueue(f,ids=f.tradeOrder) {
  const q=open('retry-trade-'+f.control)
  try { await prepareQueue(q,f,ids); return parse(await q.query(queueCall(f,true,ids.length))) }
  finally { await q.close() }
}
async function runWaiver(f,ids=f.claims) {
  const w=open('retry-waiver-'+f.control)
  try { await w.query(helpers); await prepareWaiver(w,f,ids); return parse(await w.query(waiverCall(f))) }
  finally { await w.close() }
}
async function finish(f) {
  let state=parse(await root.query(stateSql(f)))
  const pendingTrades=f.tradeOrder.filter(id=>state.trades.find(t=>t.id===id).status==='accepted')
  if(pendingTrades.length) {
    const rows=await runQueue(f,pendingTrades)
    assert.deepEqual(rows.map(r=>r.trade_id),pendingTrades)
    assert(rows.every(r=>r.status==='completed' && r.error_code===null))
  }
  state=parse(await root.query(stateSql(f)))
  const pendingClaims=f.claims.filter(id=>state.claims.find(c=>c.id===id).status==='pending')
  if(pendingClaims.length) {
    const r=await runWaiver(f,pendingClaims); assert.equal(r.ok,true)
    assert.deepEqual(r.rows.map(r=>r.claim_id),pendingClaims)
    assert(r.rows.every(r=>r.status==='succeeded'))
  }
  state=parse(await root.query(stateSql(f)))
  for(const p of f.parts) {
    assert.equal(state.trades.find(t=>t.id===p.trade).status,'completed')
    assert.equal(state.claims.find(c=>c.id===p.claim).status,'succeeded')
    assert.equal(state.wire.find(w=>w.id===p.wire).claimed_by_claim_id,p.claim)
    assert.equal(state.rosters.find(r=>r.player_id===p.player).member_id,p.members[2])
    for(const [index,balance] of [[0,101],[1,99],[2,100],[3,100]])
      assert.equal(state.balances.find(b=>b.member_id===p.members[index]).balance,balance)
  }
  assert.equal(state.transactions,4,'Each fixture has exactly its initial drop and one waiver add')
  print('actual-final-state',{control:f.control,state})
}
try {
  print('draft-source-binding',{hashes:Object.fromEntries(definitions.map(signature=>{
    const namespace=signature.slice(0,signature.indexOf('.')),name=signature.slice(signature.indexOf('.')+1,signature.indexOf('('))
    const source=readFileSync(checkout+`supabase/sql/functions/by-name/${namespace}/${name}.sql`,'utf8')
    return [signature,createHash('sha256').update(source).digest('hex')]
  }))})
  print('actual-installed-definitions',{definitions:parse(await root.query(`SELECT jsonb_object_agg(sig,pg_get_functiondef(sig::regprocedure))
    FROM unnest(ARRAY[${list(definitions)}]) sig;`))})
  for(const control of ['opposite-order-cycle','owned-waiver-rollback','uncontended-positive']) {
    const f=await fixture(control)
    if(control==='uncontended-positive') {
      const tradeRows=await runQueue(f); assert(tradeRows.every(r=>r.status==='completed'))
      const waiver=await runWaiver(f); assert.equal(waiver.ok,true); assert.equal(waiver.rows.length,2)
      await finish(f); continue
    }
    if (control === 'owned-waiver-rollback') {
      const w=open(control+'-waiver'),barrier=open(control+'-second-faab')
      const wPid=Number(await w.query('SELECT pg_backend_pid();')),bPid=Number(await barrier.query('SELECT pg_backend_pid();'))
      await w.query(helpers)
      const before=parse(await root.query(stateSql(f)))
      let pending
      try {
        await lockBalance(barrier,f.parts[1],f.parts[1].members[2])
        await prepareWaiver(w,f)
        pending=w.query(waiverCall(f)).then(output=>({output}),error=>({error}))
        await waitOn(wPid,bPid,'Second waiver FAAB waits after first claim, both leagues held')
        assert.equal(await root.query(`SELECT pg_cancel_backend(${wPid});`),'t')
        const cancelled=unwrap(await pending);assert.equal(cancelled.sqlstate,'57014')
        assert.deepEqual(parse(await root.query(stateSql(f))),before,'Cancel restores first completed claim effects')
        print('actual-owned-cancel-control',{control,cancelled,priorClaimRolledBack:true})
      } finally {
        await release(barrier); if(pending)await pending
        await w.close();await barrier.close()
      }
      await finish(f);continue
    }
    const q=open(control+'-trade'),w=open(control+'-waiver'),bt=open(control+'-trade-faab'),bw=open(control+'-waiver-faab')
    const qPid=Number(await q.query('SELECT pg_backend_pid();')),wPid=Number(await w.query('SELECT pg_backend_pid();'))
    const btPid=Number(await bt.query('SELECT pg_backend_pid();')),bwPid=Number(await bw.query('SELECT pg_backend_pid();'))
    await w.query(helpers)
    let pendingQ,pendingW
    try {
      const before=parse(await root.query(stateSql(f)))
      await lockBalance(bw,f.parts[0],f.parts[0].members[2])
      await lockBalance(bt,f.parts[1],f.parts[1].members[0])
      await prepareWaiver(w,f)
      pendingW=w.query(waiverCall(f)).then(output=>({output}),error=>({error}))
      await waitOn(wPid,bwPid,'Waiver holds L1 before its first claim FAAB read')
      await prepareQueue(q,f)
      pendingQ=q.query(queueCall(f)).then(output=>({output}),error=>({error}))
      await waitOn(qPid,btPid,'Trade holds L2 before its first completion FAAB read')
      assert.deepEqual(parse(await root.query(stateSql(f))),before)
      await release(bw)
      const waiver=unwrap(await pendingW)
      assert.equal(waiver.ok,true)
      assert.deepEqual(waiver.rows.map(row=>row.claim_id),[f.parts[0].claim])
      assert.equal(waiver.rows[0].status,'succeeded')
      const deferred=parse(await root.query(stateSql(f)))
      assert.equal(deferred.claims.find(row=>row.id===f.parts[1].claim).status,'pending')
      assert.equal(deferred.rosters.some(row=>row.player_id===f.parts[1].player),false)
      assert.equal(deferred.transactions,3,'First award commits; busy second league has no award')
      assert.deepEqual(deferred.trades,before.trades,'Trade still waits at its owned FAAB barrier')
      await release(bt)
      const tradeRows=unwrap(await pendingQ)
      assert.deepEqual(tradeRows.map(row=>row.trade_id),f.tradeOrder)
      assert(tradeRows.every(row=>row.status==='completed' && row.error_code===null))
      print('actual-cross-league-batch-results',{expected,control,tradeRows,waiver,deadlocks:0,
        busySecondClaimPreserved:true,firstClaimCommitted:true})
    } finally {
      await release(bt).catch(()=>{}); await release(bw).catch(()=>{})
      if(pendingQ) await pendingQ
      if(pendingW) await pendingW
      await q.close(); await w.close(); await bt.close(); await bw.close()
    }
    await finish(f)
  }
} finally {
  const errors=[]
  const clean=async(work)=>{try{await work()}catch(error){errors.push(error.message)}}
  for(const s of sessions) await clean(()=>s.close())
  const cleaner=root.ended?new Session('cleanup'):root
  for(const f of fixtures) for(const p of f.parts.filter(p=>p.mayClean)) await clean(async()=>{
    const tradeIds=parse(await cleaner.query(`SELECT COALESCE(jsonb_agg(id),'[]') FROM public.trades WHERE league_id=${quote(p.league)};`))
    const claimIds=parse(await cleaner.query(`SELECT COALESCE(jsonb_agg(id),'[]') FROM public.waiver_claims WHERE league_id=${quote(p.league)};`))
    await cleaner.query(`BEGIN;
      DELETE FROM public.notification_outbox WHERE member_id IN (${list(p.members)})
        ${tradeIds.length?`OR data->>'tradeId' IN (${list(tradeIds)})`:''}
        ${claimIds.length?`OR data->>'claimId' IN (${list(claimIds)})`:''};
      DELETE FROM public.league_activity WHERE league_id=${quote(p.league)};
      DELETE FROM public.roster_transactions WHERE league_id=${quote(p.league)};
      DELETE FROM public.waiver_wire_log WHERE league_id=${quote(p.league)};
      DELETE FROM public.waiver_claims WHERE league_id=${quote(p.league)};
      DELETE FROM public.waiver_priorities WHERE league_id=${quote(p.league)};
      DELETE FROM public.weekly_add_counts WHERE league_id=${quote(p.league)};
      ${tradeIds.length?`DELETE FROM public.trades WHERE id IN (${list(tradeIds)});`:''}
      DELETE FROM public.leagues WHERE id=${quote(p.league)};
      DELETE FROM public.players WHERE id=${quote(p.player)};
      DELETE FROM auth.users WHERE id IN (${list(p.users)}); COMMIT;
      DELETE FROM private.score_input_revisions WHERE scope IN (${list(p.scopes)});`)
    const remaining=parse(await cleaner.query(`SELECT jsonb_build_object(
      'users',(SELECT count(*) FROM auth.users WHERE id IN (${list(p.users)})),
      'leagues',(SELECT count(*) FROM public.leagues WHERE id=${quote(p.league)}),
      'seasons',(SELECT count(*) FROM public.league_seasons WHERE id=${quote(p.season)}),
      'members',(SELECT count(*) FROM public.league_members WHERE id IN (${list(p.members)})),
      'players',(SELECT count(*) FROM public.players WHERE id=${quote(p.player)}),
      'rosters',(SELECT count(*) FROM public.roster_players WHERE league_id=${quote(p.league)}),
      'trades',(SELECT count(*) FROM public.trades WHERE league_id=${quote(p.league)}),
      'claims',(SELECT count(*) FROM public.waiver_claims WHERE league_id=${quote(p.league)}),
      'wire',(SELECT count(*) FROM public.waiver_wire_log WHERE league_id=${quote(p.league)}),
      'priorities',(SELECT count(*) FROM public.waiver_priorities WHERE league_id=${quote(p.league)}),
      'weeklyAdds',(SELECT count(*) FROM public.weekly_add_counts WHERE league_id=${quote(p.league)}),
      'balances',(SELECT count(*) FROM public.faab_balances WHERE league_id=${quote(p.league)}),
      'transactions',(SELECT count(*) FROM public.roster_transactions WHERE league_id=${quote(p.league)}),
      'activity',(SELECT count(*) FROM public.league_activity WHERE league_id=${quote(p.league)}),
      'outbox',(SELECT count(*) FROM public.notification_outbox WHERE member_id IN (${list(p.members)})),
      'revisions',(SELECT count(*) FROM private.score_input_revisions WHERE scope IN (${list(p.scopes)})));`))
    assert(Object.values(remaining).every(n=>n===0),'Owned cleanup must reach zero: '+JSON.stringify(remaining))
    print('actual-owned-cleanup',{control:f.control,league:p.league,remaining})
  })
  await clean(()=>cleaner.close()); if(cleaner!==root) await clean(()=>root.close())
  print('cleanup-errors',{errors}); if(errors.length) throw new Error(errors.join('; '))
}

await import('../db/league-hint-contention.mjs')

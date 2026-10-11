// Actual isolated PostgreSQL queue, offer, rollback, and retry regression.
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const db = process.env.SUPABASE_DB_URL
assert(db && ['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
const expected = 'repaired'
const prefix = `owned-actual-queue-${randomUUID()}`
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
const list = (values) => values.map(quote).join(',')
const json = (value) => `${quote(JSON.stringify(value))}::jsonb`
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

// Record the canonical source for the actual queue invocation.
const checkout = fileURLToPath(new URL('../../', import.meta.url))

// The owner supplies its existing local connection. No credential files are read.
function bindSource() {
  const base = checkout + 'supabase/sql/functions/by-name/'
  const names = ['public/process_due_accepted_trades_atomic.sql',
    'public/complete_accepted_trade_atomic.sql','private/create_trade_offer.sql',
    'private/lock_trade_offer_assets.sql','public/submit_trade_offer_atomic.sql']
  const sources = Object.fromEntries(names.map((name) => [name, readFileSync(base + name, 'utf8')]))
  assert.match(sources[names[0]], /FOR UPDATE OF trade SKIP LOCKED/)
  assert.match(sources[names[0]], /PERFORM public\.complete_accepted_trade_atomic\(v_trade\.id\)/)
  assert.match(sources[names[0]], /WHEN serialization_failure OR deadlock_detected OR lock_not_available/)
  print('source-binding', { hashes: Object.fromEntries(names.map((name) =>
    [name, createHash('sha256').update(sources[name]).digest('hex')])), globalQueueExecuted: true })
}
// Session-local invoker capture records only the actual offer/retry SQLSTATE.
// The real public queue supplies its own exception boundary and output rows.
const helpers = `CREATE FUNCTION pg_temp.capture_offer(u uuid,k uuid,m uuid,p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $capture$
DECLARE t uuid;
BEGIN
  t:=public.submit_trade_offer_atomic(u,k,m,'propose',p);
  RETURN jsonb_build_object('ok',true,'result',t,'role',current_user);
EXCEPTION WHEN query_canceled THEN
  RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user);
WHEN OTHERS THEN
  RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user);
END $capture$;
GRANT EXECUTE ON FUNCTION pg_temp.capture_offer(uuid,uuid,uuid,jsonb) TO service_role;
DO $grant$ BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO service_role',
    (SELECT nspname FROM pg_namespace WHERE oid=pg_my_temp_schema()));
END $grant$;`

async function fixture(control) {
  const f = { control, league:randomUUID(), season:randomUUID(),
    users:Array.from({length:4},()=>randomUUID()), members:Array.from({length:4},()=>randomUUID()),
    request:randomUUID(), trades:[], mayClean:false }
  fixtures.push(f)
  f.scopes = [`league:${f.league}`, `season:${f.season}`]
  assert.equal(await root.query(`SELECT
    (SELECT count(*) FROM auth.users WHERE id IN (${list(f.users)}))
    +(SELECT count(*) FROM public.leagues WHERE id=${quote(f.league)})
    +(SELECT count(*) FROM public.league_seasons WHERE id=${quote(f.season)})
    +(SELECT count(*) FROM public.league_members WHERE id IN (${list(f.members)}))
    +(SELECT count(*) FROM private.trade_offer_requests WHERE user_id IN (${list(f.users)}))
    +(SELECT count(*) FROM private.score_input_revisions WHERE scope IN (${list(f.scopes)}));`),'0')
  f.mayClean = true
  await root.query(`BEGIN;
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,
      raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      SELECT id,'authenticated','authenticated',id||'@example.test','x',now(),'{}','{}',now(),now()
      FROM unnest(ARRAY[${list(f.users)}]::uuid[]) id;
    INSERT INTO public.leagues(id,name,slug,commissioner_id,status,waiver_mode,trade_deadline,
      trade_veto_mode,trade_veto_window_hours) VALUES
      (${quote(f.league)},'Owned two completion overlap',${quote(f.league)},${quote(f.users[0])},
      'active','faab',NULL,'member_vote',24);
    INSERT INTO public.league_members(id,league_id,user_id,role,team_name)
      SELECT member,${quote(f.league)},usr,
      (CASE WHEN ord=1 THEN 'commissioner' ELSE 'manager' END)::public.league_member_role,'Owned '||ord
      FROM unnest(ARRAY[${list(f.members)}]::uuid[],ARRAY[${list(f.users)}]::uuid[])
      WITH ORDINALITY AS t(member,usr,ord);
    INSERT INTO public.league_seasons(id,league_id,season_year,is_current)
      VALUES(${quote(f.season)},${quote(f.league)},2163,true);
    INSERT INTO public.faab_balances(league_id,league_season_id,member_id,balance)
      SELECT ${quote(f.league)},${quote(f.season)},id,100
      FROM unnest(ARRAY[${list(f.members)}]::uuid[]) id
      ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET balance=100;
    COMMIT;`)
  f.expires = new Date(Date.now()+86400000).toISOString()
  for (const [proposer,recipient] of [[0,1],[2,3]]) {
    const id = await root.query(`BEGIN; SET LOCAL ROLE service_role;
      SELECT public.propose_trade_atomic(${quote(f.league)},${quote(f.season)},
        ${quote(f.members[proposer])},${quote(f.members[recipient])},
        ARRAY[]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],
        'Owned accepted FAAB exchange',${quote(f.expires)}::timestamptz,1,2); COMMIT;`)
    assert.match(id,/^[0-9a-f-]{36}$/); f.trades.push(id)
    const accept = parse(await root.query(`BEGIN; SET LOCAL ROLE service_role;
      SELECT public.accept_trade_atomic(${quote(id)},${quote(f.members[recipient])}); COMMIT;`))
    assert.equal(accept.expired,false); assert.equal(accept.allAccepted,true)
  }
  // Actual proposal/acceptance produces both accepted statuses. Only own veto metadata changes.
  const oldMillis = Date.UTC(1900,0,1) + Number.parseInt(randomUUID().slice(0,8),16)
  f.oldDates = [new Date(oldMillis).toISOString(),new Date(oldMillis+1).toISOString()]
  await root.query(`UPDATE public.trades SET veto_window_expires_at=${quote(f.oldDates[0])}::timestamptz
    WHERE id=${quote(f.trades[0])} AND status='accepted';
    UPDATE public.trades SET veto_window_expires_at=${quote(f.oldDates[1])}::timestamptz
    WHERE id=${quote(f.trades[1])} AND status='accepted';`)
  assert.equal(await root.query(`SELECT count(*) FROM public.trades
    WHERE id IN (${list(f.trades)}) AND status='accepted' AND veto_window_expires_at<=now();`),'2')
  f.payload = {leagueId:f.league,leagueSeasonId:f.season,recipientMemberId:f.members[3],
    notes:'Owned fresh FAAB request',expiresAt:f.expires,
    offerPlayerIds:[],requestPlayerIds:[],offerPickIds:[],requestPickIds:[],
    offerFaabAmount:3,requestFaabAmount:4}
  return f
}
const stateSql = (f) => `SELECT jsonb_build_object(
  'trades',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM public.trades t WHERE league_id=${quote(f.league)}),
  'items',(SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]') FROM public.trade_items i
    JOIN public.trades t ON t.id=i.trade_id WHERE t.league_id=${quote(f.league)}),
  'participants',(SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.trade_id,p.member_id),'[]')
    FROM public.trade_participants p JOIN public.trades t ON t.id=p.trade_id WHERE t.league_id=${quote(f.league)}),
  'balances',(SELECT jsonb_agg(to_jsonb(b) ORDER BY member_id) FROM public.faab_balances b WHERE league_id=${quote(f.league)}),
  'receipts',(SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]') FROM private.trade_offer_requests r WHERE user_id IN (${list(f.users)})),
  'transactions',(SELECT count(*) FROM public.roster_transactions WHERE league_id=${quote(f.league)}),
  'activity',(SELECT count(*) FROM public.league_activity WHERE league_id=${quote(f.league)}),
  'outbox',(SELECT count(*) FROM public.notification_outbox WHERE member_id IN (${list(f.members)})));`
const offerCall = (f) => `SELECT pg_temp.capture_offer(${quote(f.users[2])},${quote(f.request)},
  ${quote(f.members[2])},${json(f.payload)});`

async function observeWait(aPid,bPid,f) {
  const deadline = Date.now()+6000
  while (Date.now()<deadline) {
    const evidence = parse(await root.query(`SELECT jsonb_build_object(
      'aPid',${aPid},'bPid',${bPid},'waitType',a.wait_event_type,'waitEvent',a.wait_event,
      'blockingPids',pg_blocking_pids(a.pid),'waitsOnB',${bPid}=ANY(pg_blocking_pids(a.pid)),
      'memberLocks',(SELECT count(*) FROM pg_locks l WHERE l.pid=${aPid} AND l.granted
        AND l.locktype='advisory' AND l.classid::bigint=(hashtext(${quote(f.league)})::bigint & 4294967295)
        AND l.objid::bigint IN ((hashtext(${quote(f.members[2])})::bigint & 4294967295),
          (hashtext(${quote(f.members[3])})::bigint & 4294967295)) AND l.objsubid=2),
      'waitsBTransaction',(SELECT EXISTS(
        SELECT 1 FROM pg_locks w JOIN pg_locks h ON h.locktype=w.locktype AND h.transactionid=w.transactionid
        WHERE w.pid=${aPid} AND NOT w.granted AND w.locktype='transactionid'
          AND h.pid=${bPid} AND h.granted AND h.mode='ExclusiveLock')))
      FROM pg_stat_activity a WHERE a.pid=${aPid};`))
    if (evidence.waitType==='Lock' && evidence.waitsOnB) return evidence
    await sleep(25)
  }
  throw new Error('Own fresh offer never waits on B within six seconds')
}
function assertFinal(s,f,proposal) {
  assert.equal(s.trades.length,3)
  for (const id of f.trades) {
    const t=s.trades.find((row)=>row.id===id)
    assert.equal(t.status,'completed'); assert.ok(t.completed_at)
  }
  const t=s.trades.find((row)=>row.id===proposal)
  assert.equal(t.status,'pending'); assert.equal(t.proposer_member_id,f.members[2])
  assert.equal(t.recipient_member_id,f.members[3])
  const items=s.items.filter((row)=>row.trade_id===proposal)
  assert.equal(items.length,2)
  assert.equal(items.find((row)=>row.from_member_id===f.members[2]).faab_amount,3)
  assert.equal(items.find((row)=>row.from_member_id===f.members[3]).faab_amount,4)
  assert(items.every((row)=>row.player_id===null && row.pick_id===null))
  for (let i=0;i<4;i++) assert.equal(s.balances.find((row)=>row.member_id===f.members[i]).balance,i%2===0?101:99)
  assert.equal(s.receipts.length,1); assert.equal(s.receipts[0].completed,true)
  assert.equal(s.receipts[0].result_trade_id,proposal); assert.equal(s.transactions,0)
}

const globalCandidates = (limit) => `SELECT trade.id
  FROM public.trades trade
  JOIN public.league_seasons season ON season.id=trade.league_season_id
  JOIN public.leagues league ON league.id=trade.league_id
  WHERE trade.status='accepted'::public.trade_status AND trade.veto_window_expires_at<=now()
    AND season.is_current=true
    AND league.status IN ('active'::public.league_status,'playoffs'::public.league_status,'offseason'::public.league_status)
  ORDER BY trade.veto_window_expires_at,trade.proposed_at,trade.id LIMIT ${limit}`

async function prepareQueue(q,f,ids=f.trades) {
  // Same snapshot prevents a new/changed earlier unrelated candidate entering between guard and invocation.
  // Own row locks prevent SKIP LOCKED from excluding these candidates; NOWAIT aborts instead of waiting.
  const found=parse(await q.query(`BEGIN ISOLATION LEVEL REPEATABLE READ;
    DO $own$ BEGIN
      PERFORM 1 FROM public.trades WHERE id IN (${list(ids)}) ORDER BY id FOR UPDATE NOWAIT;
      IF (SELECT count(*) FROM public.trades WHERE id IN (${list(ids)}) AND league_id=${quote(f.league)}
          AND status='accepted' AND veto_window_expires_at<=now())<>${ids.length} THEN
        RAISE EXCEPTION 'Own accepted queue candidates are unavailable';
      END IF;
    END $own$;
    SELECT COALESCE(jsonb_agg(id),'[]') FROM (${globalCandidates(ids.length)}) candidates;`))
  assert.deepEqual(found,ids,'Abort: exact real global first candidates must all be this fixture')
  print('exact-owned-global-candidates',{control:f.control,ids:found,unrelatedRowsLocked:false})
}
const queueCall = (f,ids=f.trades) => `DO $guard$ DECLARE got uuid[]; BEGIN
  SELECT array_agg(id) INTO got FROM (${globalCandidates(ids.length)}) candidates;
  IF got IS DISTINCT FROM ARRAY[${list(ids)}]::uuid[] THEN
    RAISE EXCEPTION 'Abort: global queue candidates are not exactly the own IDs';
  END IF;
END $guard$;
SET LOCAL ROLE service_role;
SELECT COALESCE(jsonb_agg(to_jsonb(result)),'[]')
  FROM public.process_due_accepted_trades_atomic(${ids.length}) result;
COMMIT;`

function assertQueueRows(rows,ids) {
  assert.deepEqual(rows.map((row)=>row.trade_id),ids,'Actual queue returns only the exact owned IDs')
  assert(rows.every((row)=>!['55P03','57014'].includes(row.error_code)),'Timeout never establishes the cycle')
}
async function releaseBarrier(barrier) {
  if (!barrier.ended && !barrier.pending) await barrier.query('ROLLBACK;')
}

try {
  bindSource()
  for (const control of ['actual-queue-overlap','actual-queue-rolls-back']) {
    const f=await fixture(control),a=open(control+'-offer'),q=open(control+'-queue'),barrier=open(control+'-barrier')
    await a.query(helpers)
    const aPid=Number(await a.query('SELECT pg_backend_pid();'))
    const qPid=Number(await q.query('SELECT pg_backend_pid();'))
    const barrierPid=Number(await barrier.query('SELECT pg_backend_pid();'))
    const before=parse(await root.query(stateSql(f)))
    let pendingA,pendingQueue
    try {
      // This third session owns only T1's exact FAAB row. It owns no trade/member/league lock.
      const balance=await barrier.query(`BEGIN;
        SELECT balance FROM public.faab_balances WHERE league_id=${quote(f.league)}
          AND league_season_id=${quote(f.season)} AND member_id=${quote(f.members[0])} FOR UPDATE;`)
      assert.equal(balance,'100')
      await prepareQueue(q,f)
      pendingQueue=q.query(queueCall(f)).then((output)=>({output}),(error)=>({error}))
      const queueWait=await observeWait(qPid,barrierPid,f)
      assert.equal(queueWait.waitsBTransaction,true,'Actual first completion waits on the exact FAAB row barrier')
      // The actual completion acquires league/current-season rows before ensure_faab_balance.
      // Inspect own PID/key only; there is no unrelated lock/write inspection.
      const held=parse(await root.query(`SELECT jsonb_build_object(
        'ownLeagueRelation',(SELECT EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=${qPid}
          AND l.granted AND l.locktype='relation' AND l.relation='public.leagues'::regclass
          AND l.mode='RowShareLock')),
        'ownMemberLocks',(SELECT count(*) FROM pg_locks l WHERE l.pid=${qPid} AND l.granted
          AND l.locktype='advisory' AND l.classid::bigint=(hashtext(${quote(f.league)})::bigint & 4294967295)
          AND l.objid::bigint IN ((hashtext(${quote(f.members[0])})::bigint & 4294967295),
            (hashtext(${quote(f.members[1])})::bigint & 4294967295)) AND l.objsubid=2));`))
      assert.equal(held.ownLeagueRelation,true); assert.equal(held.ownMemberLocks,2)
      print('actual-queue-waits-on-own-faab-barrier',{control,queueWait,held})
      pendingA=a.query(`BEGIN; SET LOCAL ROLE service_role; ${offerCall(f)}`)
        .then((output)=>({output}),(error)=>({error}))
      const offerWait=await observeWait(aPid,qPid,f)
      assert.equal(offerWait.waitEvent, 'advisory')
      assert.equal(offerWait.memberLocks, 0)
      print('actual-proposal-waits-on-queue',{expected,control,offerWait})
      assert.deepEqual(parse(await root.query(stateSql(f))),before)
      let resultA,queueRows
      if (control==='actual-queue-rolls-back') {
        // Cancel only the owned blocked queue statement. ON_ERROR_STOP closes that owned connection,
        // which rolls back the whole queue transaction. This cancellation is not deadlock evidence.
        assert.equal(await root.query(`SELECT pg_cancel_backend(${qPid});`),'t')
        const cancelled=await pendingQueue
        assert('error' in cancelled,'Owned queue cancellation must fail the actual statement')
        assert.match(cancelled.error.message,/canceling statement due to user request/)
        await q.close()
        await releaseBarrier(barrier)
        const doneA=await pendingA
        if ('error' in doneA) throw doneA.error
        resultA=parse(doneA.output); assert.equal(resultA.ok,true)
        assert.deepEqual(parse(await root.query(stateSql(f))),before,'Queue rollback restores sources/balances; A remains uncommitted')
        await a.query('COMMIT;')
        const rolledBack=parse(await root.query(stateSql(f)))
        for (const id of f.trades) assert.deepEqual(rolledBack.trades.find((r)=>r.id===id),before.trades.find((r)=>r.id===id))
        assert.deepEqual(rolledBack.balances,before.balances)
        const retry=open(control+'-queue-retry')
        try {
          await prepareQueue(retry,f)
          queueRows=parse(await retry.query(queueCall(f)))
          assertQueueRows(queueRows,f.trades)
          assert(queueRows.every((row)=>row.status==='completed' && row.error_code===null))
        } finally { await retry.close() }
        print('actual-queue-rollback-control',{resultA,queueRows,ownCancellation:true})
      } else {
        await releaseBarrier(barrier)
        const done=await Promise.all([pendingA,pendingQueue])
        if ('error' in done[0]) throw done[0].error
        if ('error' in done[1]) throw done[1].error
        resultA=parse(done[0].output); queueRows=parse(done[1].output)
        await a.query('COMMIT;')
        assertQueueRows(queueRows,f.trades)
        assert(!['55P03','57014'].includes(resultA.sqlstate),'Timeout never proves actual queue deadlock')
        assert.equal(queueRows[0].status,'completed'); assert.equal(queueRows[0].error_code,null)
        const deadlocks=queueRows.filter((row)=>row.error_code==='40P01').length
          +(resultA.sqlstate==='40P01'?1:0)
        assert.equal(deadlocks,0); assert.equal(resultA.ok,true)
        assert(queueRows.every((row)=>row.status==='completed' && row.error_code===null))
        print('actual-public-queue-and-offer-result',{expected,queueRows,resultA})
        const collision=parse(await root.query(stateSql(f)))
        assert.equal(collision.trades.find((r)=>r.id===f.trades[0]).status,'completed')

      }
      assert.equal(resultA.role,'service_role')
      const after=parse(await root.query(stateSql(f))); assertFinal(after,f,resultA.result)
      const replay=parse(await a.query(`BEGIN; SET LOCAL ROLE service_role; ${offerCall(f)} COMMIT;`))
      assert.equal(replay.ok,true); assert.equal(replay.result,resultA.result)
      assert.deepEqual(parse(await root.query(stateSql(f))),after)
      print('actual-queue-completions-and-offer-verified',{expected,control,after})
    } finally {
      await releaseBarrier(barrier).catch(()=>{})
      // Releasing the owned barrier lets both outstanding actual calls leave their bounded waits.
      if (pendingQueue) await pendingQueue
      if (!q.ended && !q.pending) await q.query('ROLLBACK;').catch(()=>{})
      if (pendingA) await pendingA
      await a.close(); await q.close(); await barrier.close()
    }
  }
} finally {
  const errors=[]
  const clean=async(work)=>{try{await work()}catch(error){errors.push(error.message)}}
  for (const session of sessions) await clean(()=>session.close())
  const cleaner=root.ended?new Session('cleanup'):root
  for (const f of fixtures.filter((f)=>f.mayClean)) await clean(async()=>{
    const ids=parse(await cleaner.query(`SELECT COALESCE(jsonb_agg(id),'[]') FROM public.trades WHERE league_id=${quote(f.league)};`))
    await cleaner.query(`BEGIN;
      DELETE FROM private.trade_offer_requests WHERE user_id=${quote(f.users[2])} AND request_id=${quote(f.request)};
      DELETE FROM public.notification_outbox WHERE member_id IN (${list(f.members)})
        ${ids.length?`OR data->>'tradeId' IN (${list(ids)})`:''};
      DELETE FROM public.league_activity WHERE league_id=${quote(f.league)};
      DELETE FROM public.roster_transactions WHERE league_id=${quote(f.league)};
      ${ids.length?`DELETE FROM public.trades WHERE id IN (${list(ids)});`:''}
      DELETE FROM public.leagues WHERE id=${quote(f.league)};
      DELETE FROM auth.users WHERE id IN (${list(f.users)}); COMMIT;
      DELETE FROM private.score_input_revisions WHERE scope IN (${list(f.scopes)});`)
    const remaining=parse(await cleaner.query(`SELECT jsonb_build_object(
      'users',(SELECT count(*) FROM auth.users WHERE id IN (${list(f.users)})),
      'league',(SELECT count(*) FROM public.leagues WHERE id=${quote(f.league)}),
      'season',(SELECT count(*) FROM public.league_seasons WHERE id=${quote(f.season)}),
      'members',(SELECT count(*) FROM public.league_members WHERE id IN (${list(f.members)})),
      'balances',(SELECT count(*) FROM public.faab_balances WHERE league_id=${quote(f.league)}),
      'trades',(SELECT count(*) FROM public.trades WHERE league_id=${quote(f.league)}),
      'transactions',(SELECT count(*) FROM public.roster_transactions WHERE league_id=${quote(f.league)}),
      'activity',(SELECT count(*) FROM public.league_activity WHERE league_id=${quote(f.league)}),
      'outbox',(SELECT count(*) FROM public.notification_outbox WHERE member_id IN (${list(f.members)})),
      'receipts',(SELECT count(*) FROM private.trade_offer_requests WHERE user_id IN (${list(f.users)})),
      'revisions',(SELECT count(*) FROM private.score_input_revisions WHERE scope IN (${list(f.scopes)})));`))
    assert(Object.values(remaining).every((count)=>count===0),`Own cleanup leaves rows: ${JSON.stringify(remaining)}`)
    print('actual-owned-cleanup',{control:f.control,remaining})
  })
  await clean(()=>cleaner.close()); if (cleaner!==root) await clean(()=>root.close())
  print('cleanup-errors',{errors}); if(errors.length) throw new Error(`Own cleanup fails: ${errors.join('; ')}`)
}

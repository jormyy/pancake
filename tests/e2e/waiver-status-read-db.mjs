import { spawn } from 'node:child_process'
import { randomUUID,createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const db = process.env.SUPABASE_DB_URL
assert(db && ['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
const prefix = `owned-ui-overlap-${randomUUID()}`
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
// Actual role and database checks use only uniquely owned synthetic fixtures.
const checkout=fileURLToPath(new URL('../../', import.meta.url))
const names=['public/get_member_transaction_state.sql','public/process_due_waiver_claims_atomic.sql',
 'public/process_next_waiver_claim_atomic.sql','private/assert_weekly_add_available.sql','private/ensure_faab_balance.sql']
print('draft-source-binding',{hashes:Object.fromEntries(names.map(n=>[n,createHash('sha256')
 .update(readFileSync(checkout+'supabase/sql/functions/by-name/'+n,'utf8')).digest('hex')]))})
// Capture errors only. No replacement, injected production failure, or sleep in production paths.
const helpers=`CREATE FUNCTION pg_temp.capture_ui(l uuid,m uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER AS $cap$ DECLARE rows jsonb; BEGIN
 SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]') INTO rows FROM public.get_member_transaction_state(m,l) r;
 RETURN jsonb_build_object('ok',true,'rows',rows,'role',current_user);
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user); END $cap$;
CREATE FUNCTION pg_temp.capture_waiver(d date) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER AS $cap$ DECLARE rows jsonb; BEGIN
 SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]') INTO rows FROM public.process_due_waiver_claims_atomic(d,2) r;
 RETURN jsonb_build_object('ok',true,'rows',rows,'role',current_user);
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user); END $cap$;
GRANT EXECUTE ON FUNCTION pg_temp.capture_ui(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.capture_waiver(date) TO service_role;
DO $g$ BEGIN EXECUTE format('GRANT USAGE ON SCHEMA %I TO authenticated,service_role',
 (SELECT nspname FROM pg_namespace WHERE oid=pg_my_temp_schema())); END $g$;`
const eligible=f=>`SELECT DISTINCT c.id FROM public.waiver_claims c
 JOIN public.waiver_wire_log w ON w.league_id=c.league_id AND w.league_season_id=c.league_season_id
 AND w.player_id=c.player_id AND w.cleared_at IS NULL AND w.clears_at<=now()
 JOIN public.leagues l ON l.id=c.league_id AND l.status IN ('active','playoffs','offseason')
 JOIN public.league_seasons s ON s.id=c.league_season_id AND s.is_current=true
 WHERE c.status='pending' AND c.process_date<=${quote(f.processDate)}::date`
const queue=f=>`SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]') FROM (${eligible(f)}) e;`
const guard=f=>`DO $guard$ DECLARE got uuid[]; BEGIN
 SELECT array_agg(id ORDER BY id) INTO got FROM (${eligible(f)}) e;
 IF got IS DISTINCT FROM ARRAY[${list(f.claims.slice().sort())}]::uuid[] THEN
 RAISE EXCEPTION 'Abort: global waiver queue contains other claims'; END IF; END $guard$;`
const state=f=>`SELECT jsonb_build_object(
 'claims',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.waiver_claims c WHERE league_id=${quote(f.league)}),
 'rosters',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.roster_players r WHERE league_id=${quote(f.league)}),
 'wire',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM public.waiver_wire_log w WHERE league_id=${quote(f.league)}),
 'balances',(SELECT jsonb_agg(to_jsonb(b) ORDER BY member_id) FROM public.faab_balances b WHERE league_id=${quote(f.league)}),
 'priorities',(SELECT jsonb_agg(to_jsonb(p) ORDER BY member_id) FROM public.waiver_priorities p WHERE league_id=${quote(f.league)}),
 'transactions',(SELECT count(*) FROM public.roster_transactions WHERE league_id=${quote(f.league)}),
 'activity',(SELECT count(*) FROM public.league_activity WHERE league_id=${quote(f.league)}));`
async function fixture(control) {
 const f={control,league:randomUUID(),season:randomUUID(),users:Array.from({length:3},()=>randomUUID()),
 members:Array.from({length:3},()=>randomUUID()),players:Array.from({length:2},()=>randomUUID()),
 rosters:Array.from({length:2},()=>randomUUID()),claims:[],processDate:'1900-01-03',mayClean:false}
 f.scopes=[`league:${f.league}`,`season:${f.season}`,...f.players.map(x=>`player:${x}`)]; fixtures.push(f)
 assert.equal(await root.query(`SELECT
 (SELECT count(*) FROM auth.users WHERE id IN (${list(f.users)}))+
 (SELECT count(*) FROM public.leagues WHERE id=${quote(f.league)})+
 (SELECT count(*) FROM public.league_seasons WHERE id=${quote(f.season)})+
 (SELECT count(*) FROM public.league_members WHERE id IN (${list(f.members)}))+
 (SELECT count(*) FROM public.players WHERE id IN (${list(f.players)}))+
 (SELECT count(*) FROM public.roster_players WHERE id IN (${list(f.rosters)}))+
 (SELECT count(*) FROM private.score_input_revisions WHERE scope IN (${list(f.scopes)}));`),'0')
 f.mayClean=true
 await root.query(`BEGIN;
 INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 SELECT id,'authenticated','authenticated',id||'@example.test','x',now(),'{}','{}',now(),now()
 FROM unnest(ARRAY[${list(f.users)}]::uuid[]) id;
 INSERT INTO public.leagues(id,name,slug,commissioner_id,status,waiver_mode,trade_deadline,roster_size,weekly_add_limit)
 VALUES(${quote(f.league)},'Owned UI waiver inversion',${quote(f.league)},${quote(f.users[0])},'active','faab',NULL,20,5);
 INSERT INTO public.league_members(id,league_id,user_id,role,team_name)
 SELECT m,${quote(f.league)},u,(CASE WHEN n=1 THEN 'commissioner' ELSE 'manager' END)::public.league_member_role,'Owned '||n
 FROM unnest(ARRAY[${list(f.members)}]::uuid[],ARRAY[${list(f.users)}]::uuid[]) WITH ORDINALITY t(m,u,n);
 INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(${quote(f.season)},${quote(f.league)},2164,true);
 INSERT INTO public.waiver_priorities(league_id,league_season_id,member_id,priority)
 SELECT ${quote(f.league)},${quote(f.season)},id,n::int FROM unnest(ARRAY[${list(f.members)}]::uuid[]) WITH ORDINALITY t(id,n);
 INSERT INTO public.faab_balances(league_id,league_season_id,member_id,balance)
 SELECT ${quote(f.league)},${quote(f.season)},id,100 FROM unnest(ARRAY[${list(f.members)}]::uuid[]) id
 ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET balance=100;
 INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team,years_exp)
 SELECT id,'Synthetic',id::text,'PG',ARRAY['PG'],NULL,2 FROM unnest(ARRAY[${list(f.players)}]::uuid[]) id;
 INSERT INTO public.roster_players(id,player_id,member_id,league_id,league_season_id,acquired_via,is_on_ir,is_on_taxi)
 SELECT r,p,${quote(f.members[2])},${quote(f.league)},${quote(f.season)},'draft',false,false
 FROM unnest(ARRAY[${list(f.rosters)}]::uuid[],ARRAY[${list(f.players)}]::uuid[]) t(r,p); COMMIT;`)
 for(let i=0;i<2;i++) {
  await root.query(`BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claim.sub',${quote(f.users[2])},true);
   SELECT public.drop_player_atomic(${quote(f.rosters[i])},${quote(f.season)},NULL::uuid); COMMIT;`)
  await root.query(`UPDATE public.waiver_wire_log SET placed_on_waivers_at='1900-01-0${i+1} 12:00:00+00',
   clears_at='1900-01-0${i+2} 12:00:00+00' WHERE league_id=${quote(f.league)} AND player_id=${quote(f.players[i])} AND cleared_at IS NULL;`)
  const claim=await root.query(`BEGIN; SET LOCAL ROLE service_role;
   SELECT public.create_waiver_claim_atomic(${quote(f.league)},${quote(f.members[i])},${quote(f.players[i])},
   NULL::uuid,${quote(f.users[i])},1,1); COMMIT;`)
  assert.match(claim,/^[0-9a-f-]{36}$/);f.claims.push(claim)
 }
 f.week=Number(await root.query(`SELECT week_number FROM private.current_add_week(${quote(f.league)},${quote(f.season)});`))
 await root.query(`DELETE FROM public.weekly_add_counts WHERE league_id=${quote(f.league)};`)
 if(control==='existingcount') await root.query(`INSERT INTO public.weekly_add_counts(league_id,league_season_id,member_id,week_number,add_count)
 VALUES(${quote(f.league)},${quote(f.season)},${quote(f.members[1])},${f.week},0);`)
 assert.deepEqual(parse(await root.query(queue(f))),f.claims.slice().sort())
 return f
}
async function prepare(w,f) {
 const ids=parse(await w.query(`BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL deadlock_timeout='1s';
 DO $own$ BEGIN IF NOT pg_try_advisory_xact_lock(hashtext(${quote(f.league)}),hashtext(${quote(f.season)}))
 THEN RAISE EXCEPTION 'Abort: owned queue is busy'; END IF; END $own$; ${queue(f)}`))
 assert.deepEqual(ids,f.claims.slice().sort());print('exact-own-eligible-queue',{control:f.control,ids})
}
const call=(f)=>`${guard(f)} SET LOCAL ROLE service_role;
 SELECT pg_temp.capture_waiver(${quote(f.processDate)}::date); COMMIT;`
async function waitOn(pid,blocker,settled) {
 const deadline=Date.now()+6000
 while(Date.now()<deadline) {
  if(settled()) throw new Error('Waiver settles before owned balance wait is observed')
  const row=parse(await root.query(`SELECT jsonb_build_object('pid',pid,'waitType',wait_event_type,
   'waitEvent',wait_event,'blockers',pg_blocking_pids(pid)) FROM pg_stat_activity WHERE pid=${pid};`))
  if(row.waitType==='Lock'&&row.blockers.includes(blocker)) return row
  await sleep(10)
 }
 throw new Error('No owned balance wait within six seconds')
}
function succeeded(s,f) {
 assert(s.claims.every(c=>c.status==='succeeded'));assert.equal(s.rosters.length,2)
 for(let i=0;i<2;i++) {
  assert.equal(s.rosters.find(r=>r.player_id===f.players[i]).member_id,f.members[i])
  assert.equal(s.balances.find(b=>b.member_id===f.members[i]).balance,99)
 }
}
try {
 print('actual-installed-definitions',{definitions:parse(await root.query(`SELECT jsonb_object_agg(n,pg_get_functiondef(n::regprocedure))
 FROM unnest(ARRAY['public.get_member_transaction_state(uuid,uuid)','public.process_due_waiver_claims_atomic(date,integer)',
 'public.process_next_waiver_claim_atomic(date)','private.ensure_faab_balance(uuid,uuid,uuid)',
 'private.assert_weekly_add_available(uuid,uuid,uuid)']) n;`))})
 for(const control of ['missingcount','existingcount']) {
  const f=await fixture(control),u=open(control+'-ui'),w=open(control+'-waiver')
  await u.query(helpers);await w.query(helpers)
  const wPid=Number(await w.query('SELECT pg_backend_pid();'))
  const before=parse(await root.query(state(f)))
  const countSql=`SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY member_id),'[]') FROM public.weekly_add_counts c WHERE league_id=${quote(f.league)};`
  const countsBefore=parse(await root.query(countSql))
  // A separate owned session holds the second claimant's balance.
  // Neither actual authenticated reader acquires a synthetic lock.
  const barrier=open(control+'-balance-barrier')
  const barrierPid=Number(await barrier.query('SELECT pg_backend_pid();'))
  assert.equal(await barrier.query(`BEGIN; SELECT balance FROM public.faab_balances
   WHERE league_id=${quote(f.league)} AND league_season_id=${quote(f.season)}
   AND member_id=${quote(f.members[1])} FOR UPDATE;`),'100')
  await prepare(w,f)
  let settled=false
  const pendingW=w.query(call(f)).then(raw=>({value:parse(raw)}),error=>({error})).finally(()=>{settled=true})
  const wait=await waitOn(wPid,barrierPid,()=>settled)
  print('actual-owned-balance-wait',{control,wait,uiHasSyntheticPrelock:false})
  assert.deepEqual(parse(await root.query(state(f))),before)
  const reads=[]
  for(let i=0;i<2;i++) {
   // Two readers cover a balance changed but uncommitted by the first award,
   // and an unchanged balance locked by the third-session barrier.
   const ui=parse(await u.query(`BEGIN; SET LOCAL statement_timeout='1500ms'; SET LOCAL ROLE authenticated;
    SELECT set_config('request.jwt.claim.sub',${quote(f.users[i])},true);
    SELECT pg_temp.capture_ui(${quote(f.league)},${quote(f.members[i])}); COMMIT;`).then(raw=>raw.split('\n').at(-1)))
   assert.equal(ui.ok,true);assert.equal(ui.role,'authenticated');assert.equal(ui.rows.length,1)
   const row=ui.rows[0]
   assert.equal(row.league_season_id,f.season);assert.equal(row.week_number,f.week)
   assert.equal(row.faab_balance,100);assert.equal(row.weekly_add_count,0)
   assert.equal(row.weekly_add_limit,5);assert.equal(row.add_limit_message,null)
   reads.push(ui)
  }
  assert.equal(settled,false,'Waiver remains on separate owned barrier after both real reads finish')
  assert.deepEqual(parse(await root.query(state(f))),before)
  assert.deepEqual(parse(await root.query(countSql)),countsBefore,'Real reads create no counter rows')
  print('actual-real-read-overlap',{control,reads,uiHasSyntheticPrelock:false,waiverStillWaiting:true,visibleStateUnchanged:true})
  await barrier.query('ROLLBACK;')
  const done=await pendingW;if ('error' in done) throw done.error
  assert.equal(done.value.ok,true);assert.equal(done.value.rows.length,2)
  succeeded(parse(await root.query(state(f))),f)
  const countsAfter=parse(await root.query(countSql))
  for(let i=0;i<2;i++) assert.equal(countsAfter.find(c=>c.member_id===f.members[i]).add_count,1)
  print('actual-waiver-completion-after-real-reads',{control,waiver:done.value,countsAfter})
  await barrier.close();await u.close();await w.close()
 }
} finally {
 const errors=[];const clean=async(fn)=>{try{await fn()}catch(e){errors.push(e.message)}}
 for(const s of sessions) await clean(()=>s.close())
 const c=root.ended?new Session('cleanup'):root
 for(const f of fixtures.filter(f=>f.mayClean)) await clean(async()=>{
  await c.query(`BEGIN;
   DELETE FROM public.notification_outbox WHERE member_id IN (${list(f.members)}) OR data->>'claimId' IN (${list(f.claims.length?f.claims:[''])});
   DELETE FROM public.league_activity WHERE league_id=${quote(f.league)};
   DELETE FROM public.roster_transactions WHERE league_id=${quote(f.league)};
   DELETE FROM public.waiver_wire_log WHERE league_id=${quote(f.league)};
   DELETE FROM public.waiver_claims WHERE league_id=${quote(f.league)};
   DELETE FROM public.waiver_priorities WHERE league_id=${quote(f.league)};
   DELETE FROM public.weekly_add_counts WHERE league_id=${quote(f.league)};
   DELETE FROM public.leagues WHERE id=${quote(f.league)};
   DELETE FROM public.players WHERE id IN (${list(f.players)});
   DELETE FROM auth.users WHERE id IN (${list(f.users)});COMMIT;
   DELETE FROM private.score_input_revisions WHERE scope IN (${list(f.scopes)});`)
  const remaining=parse(await c.query(`SELECT jsonb_build_object(
   'users',(SELECT count(*) FROM auth.users WHERE id IN (${list(f.users)})),
   'league',(SELECT count(*) FROM public.leagues WHERE id=${quote(f.league)}),
   'season',(SELECT count(*) FROM public.league_seasons WHERE id=${quote(f.season)}),
   'members',(SELECT count(*) FROM public.league_members WHERE id IN (${list(f.members)})),
   'players',(SELECT count(*) FROM public.players WHERE id IN (${list(f.players)})),
   'rosters',(SELECT count(*) FROM public.roster_players WHERE league_id=${quote(f.league)}),
   'claims',(SELECT count(*) FROM public.waiver_claims WHERE league_id=${quote(f.league)}),
   'wire',(SELECT count(*) FROM public.waiver_wire_log WHERE league_id=${quote(f.league)}),
   'balances',(SELECT count(*) FROM public.faab_balances WHERE league_id=${quote(f.league)}),
   'counts',(SELECT count(*) FROM public.weekly_add_counts WHERE league_id=${quote(f.league)}),
   'priorities',(SELECT count(*) FROM public.waiver_priorities WHERE league_id=${quote(f.league)}),
   'transactions',(SELECT count(*) FROM public.roster_transactions WHERE league_id=${quote(f.league)}),
   'activity',(SELECT count(*) FROM public.league_activity WHERE league_id=${quote(f.league)}),
   'outbox',(SELECT count(*) FROM public.notification_outbox WHERE member_id IN (${list(f.members)})),
   'revisions',(SELECT count(*) FROM private.score_input_revisions WHERE scope IN (${list(f.scopes)})));`))
  assert(Object.values(remaining).every(n=>n===0));print('actual-owned-cleanup',{control:f.control,remaining})
 })
 await clean(()=>c.close());if(c!==root)await clean(()=>root.close())
 print('cleanup-errors',{errors});if(errors.length)throw new Error(errors.join('; '))
}

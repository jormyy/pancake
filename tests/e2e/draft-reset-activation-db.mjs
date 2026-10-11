// Real function-entry overlap. A third owned transaction gates the draft row.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
const db = process.env.SUPABASE_DB_URL
assert(db && new URL(db).hostname === '127.0.0.1')
async function verify(action) {
assert.ok(['activate','pause','resume','stop'].includes(action))
const initialStatus = action === 'activate' ? 'completed' : action === 'resume' ? 'paused' : 'in_progress'
const prefix = 'owned-draft163-' + randomUUID()
const quote = value => "'" + String(value).replaceAll("'", "''") + "'"
const parse = value => JSON.parse(value)
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

const root = new Session('inspect');
const a = new Session('activation'), b = new Session('reset');
const user=randomUUID(), league=randomUUID(), season=randomUUID(), member=randomUUID(), draft=randomUUID();
const ownRows=`SELECT jsonb_build_object('league',(SELECT status FROM leagues WHERE id=${quote(league)}),'draft',(SELECT status FROM drafts WHERE id=${quote(draft)}),'audit',(SELECT count(*) FROM draft_audit_logs WHERE draft_id=${quote(draft)}))`;
const actionHelper=`CREATE FUNCTION pg_temp.run_action(action text,d uuid,u uuid) RETURNS jsonb LANGUAGE plpgsql AS $f$ DECLARE activated boolean; BEGIN IF action='activate' THEN activated:=public.activate_rookie_draft_league_atomic(d); ELSIF action='pause' THEN PERFORM public.pause_draft_atomic(d,u); ELSIF action='resume' THEN PERFORM public.resume_draft_atomic(d,u); ELSIF action='stop' THEN PERFORM public.stop_draft_atomic(d,u); ELSE PERFORM public.reset_draft_atomic(d,u); END IF; RETURN jsonb_build_object('ok',true,'action',action,'activated',activated); EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('ok',false,'action',action,'code',SQLSTATE,'message',SQLERRM); END $f$;`;
let reached=false, originalFailure;
console.log(JSON.stringify({ownedFixture:{user,league,season,member,draft}}));
try {
  await root.query(`INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES(${quote(user)},'authenticated','authenticated',${quote(user+'@example.test')},'synthetic-unusable',now(),'{}','{}',now(),now());
  INSERT INTO leagues(id,name,slug,commissioner_id,status) VALUES(${quote(league)},'Synthetic draft lock',${quote(league)},${quote(user)},'drafting');
  INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${quote(member)},${quote(league)},${quote(user)},'commissioner','Synthetic owner');
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${quote(season)},${quote(league)},9173,true);
  INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds) VALUES(${quote(draft)},${quote(league)},${quote(season)},'snake',${quote(initialStatus)},false,1);
  INSERT INTO snake_draft_picks(draft_id,overall_pick,round,pick_in_round,member_id,skipped_at,skip_reason) VALUES(${quote(draft)},1,1,1,${quote(member)},now(),'No eligible players');`);
  await a.query(actionHelper); await b.query(actionHelper);
  const apid=Number(await a.query('SELECT pg_backend_pid();')), bpid=Number(await b.query('SELECT pg_backend_pid();'));
  const gatePid=Number(await root.query('SELECT pg_backend_pid();'));
  await root.query(`BEGIN; SELECT id FROM drafts WHERE id=${quote(draft)} FOR UPDATE;`);
  const actionRun=a.query(`BEGIN; SET LOCAL deadlock_timeout='100ms'; SET LOCAL ROLE service_role; SELECT pg_temp.run_action(${quote(action)},${quote(draft)},${quote(user)});`);
  actionRun.catch(() => {});
  async function blocked(pid, blocker) {
    for(let i=0;i<100;i++) {
      const state=parse(await root.query(`SELECT jsonb_build_object('pid',pid,'event',wait_event,'type',wait_event_type,'blockers',pg_blocking_pids(pid)) FROM pg_stat_activity WHERE pid=${pid};`));
      if(state.type==='Lock'&&(Array.isArray(blocker)?blocker.some(value=>state.blockers.includes(value)):state.blockers.includes(blocker))) return state;
      await new Promise(r=>setTimeout(r,20));
    }
    throw new Error('Actual function did not reach its controlled wait');
  }
  const actionWait=await blocked(apid,gatePid);
  const reset=b.query(`BEGIN; SET LOCAL ROLE service_role; SELECT pg_temp.run_action('reset',${quote(draft)},${quote(user)});`);
  reset.catch(() => {});
  const wait=await blocked(bpid,apid);
  console.log(JSON.stringify({case:'actual function entry gates',action,actionWait,resetWait:wait}));
  await root.query('COMMIT;');
  const resultA=parse(await actionRun);
  await a.query('COMMIT;');
  const resultB=parse(await reset); await b.query('COMMIT;');
  console.log(JSON.stringify({case:'actual function returns',action,resultA,resultB}));
  const after=parse(await root.query(ownRows));
  console.log(JSON.stringify({case:'current actual functions lock overlap',resultA,resultB,after,limit:'Third own transaction delays draft row; both competing operations enter actual functions without injected advisory locks; service-role SQL, not browser/HTTP concurrency'}));
  assert.ok(resultA.ok&&resultB.ok);
  assert.equal(wait.event,'advisory');
  assert.equal(after.audit,action==='activate'?1:2);
  assert.equal(after.draft,'in_progress');
  assert.equal(after.league,'drafting');
  if(action==='activate') assert.equal(resultA.activated,true);
  // Restore this new fixture to completed and prove both legal operations succeed sequentially.
  await root.query(`UPDATE drafts SET status=${quote(initialStatus)},completed_at=NULL,pause_reason='manual' WHERE id=${quote(draft)}; UPDATE snake_draft_picks SET skipped_at=now(),skip_reason='No eligible players' WHERE draft_id=${quote(draft)};UPDATE leagues SET status='drafting' WHERE id=${quote(league)};`);
  await root.query(actionHelper);
  const controlA=parse(await root.query(`SELECT pg_temp.run_action(${quote(action)},${quote(draft)},${quote(user)});`));
  const controlB=parse(await root.query(`SELECT pg_temp.run_action('reset',${quote(draft)},${quote(user)});`));
  assert.ok(controlA.ok&&controlB.ok);
  console.log(JSON.stringify({case:'sequential positive',controlA,controlB,after:parse(await root.query(ownRows))}));
  reached=true;
} catch(error) {
  console.log(JSON.stringify({originalFailure:String(error),ownStderr:{a:a.stderr,b:b.stderr,root:root.stderr}}));
  originalFailure=error;
} finally {
  const errors=[];
  try { await root.query('ROLLBACK;'); } catch(e) { errors.push(String(e)); }
  for(const s of [a,b])try{await s.close()}catch(e){errors.push(String(e))}
  const cleanup=new Session('cleanup');
  try {await cleanup.query(`DELETE FROM snake_draft_picks WHERE draft_id=${quote(draft)}; DELETE FROM drafts WHERE id=${quote(draft)}; DELETE FROM leagues WHERE id=${quote(league)};DELETE FROM auth.users WHERE id=${quote(user)};DELETE FROM private.score_input_revisions WHERE scope IN (${quote('league:'+league)},${quote('season:'+season)});`);
    const remaining=Number(await cleanup.query(`SELECT (SELECT count(*) FROM leagues WHERE id=${quote(league)})+(SELECT count(*) FROM auth.users WHERE id=${quote(user)})+(SELECT count(*) FROM drafts WHERE id=${quote(draft)})+(SELECT count(*) FROM league_members WHERE id=${quote(member)});`));assert.equal(remaining,0);
    console.log(JSON.stringify({cleanup:'own fixtures0, own SQL sessions closed; temp wrappers end with sessions',reached}));
  } catch(e){errors.push(String(e))} finally {await cleanup.close();await root.close()}
  if(errors.length) throw new AggregateError([...(originalFailure?[originalFailure]:[]),...errors],'Owned fixture cleanup errors');
}

if(originalFailure) throw originalFailure;

}
for (const action of ['activate', 'pause', 'resume', 'stop']) await verify(action)

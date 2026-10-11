import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
const db = process.env.SUPABASE_DB_URL
assert(db && new URL(db).hostname === '127.0.0.1')
const prefix = 'owned-identity-' + randomUUID()
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

const root = new Session('inspect')
const sessions = []
const cohorts = []
const open = name => { const s = new Session(name); sessions.push(s); return s }
// A rookie on the latest draft board has no NBA experience; a board matching an experienced player is refused.
const metadata = {nba_team:'BOS',position:'G',eligible_positions:['G'],status:'ACT',injury_status:null,years_exp:0}
function records(source, tag) {
  if(source==='nba_draft') return Array.from({length:50},(_,i)=>({display_name:`Athlete${i} ${tag}`,nba_draft_number:i+1}))
  if(source==='nba_cdn') return [{provider_id:`nba-${tag}`,display_name:`Athlete0 ${tag}`}]
  return [{provider_id:`espn-${tag}`,first_name:'Athlete0',last_name:tag,metadata}]
}
const call = (source,tag) => `SELECT public.resolve_player_imports_atomic(${quote(source)},${quote(JSON.stringify(records(source,tag)))}::jsonb);`
const rows = tag => `SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') FROM public.players p WHERE last_name=${quote(tag)};`
async function waitFor(aPid,bPid) {
  const deadline=Date.now()+4000
  while(Date.now()<deadline) {
    const state=parse(await root.query(`SELECT jsonb_build_object('pid',pid,'event',wait_event,'type',wait_event_type,'blockers',pg_blocking_pids(pid)) FROM pg_stat_activity WHERE pid=${bPid};`))
    if(state.type==='Lock' && state.event==='advisory' && state.blockers.includes(aPid)) return state
    await new Promise(r=>setTimeout(r,20))
  }
  throw new Error('Second actual importer did not wait on first identity transaction')
}
try {
  const cases=[['nba_cdn','espn','COMMIT'],['espn','nba_cdn','COMMIT'],['nba_cdn','nba_cdn','COMMIT'],
    ['espn','espn','COMMIT'],['nba_cdn','espn','ROLLBACK'],['espn','nba_cdn','ROLLBACK'],
    ['nba_draft','espn','ROLLBACK'],['nba_draft','nba_cdn','ROLLBACK'],['nba_draft','nba_draft','ROLLBACK'],
    ['espn','nba_draft','COMMIT'],['nba_cdn','nba_draft','COMMIT']]
  for(const [sourceA,sourceB,outcome] of cases) {
    const tag='Identity'+randomUUID().replaceAll('-','');cohorts.push(tag)
    assert.deepEqual(parse(await root.query(rows(tag))),[])
    const a=open(tag+'-A'),b=open(tag+'-B')
    const aPid=Number(await a.query('SELECT pg_backend_pid();')),bPid=Number(await b.query('SELECT pg_backend_pid();'))
    const beforeDraft=await root.query("SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(id,nba_draft_number) ORDER BY id)::text,'')) FROM public.players WHERE nba_draft_number IS NOT NULL;")
    await a.query('BEGIN; SET LOCAL ROLE service_role;')
    const resultA=parse(await a.query(call(sourceA,tag)))
    const idA=resultA.results[0].player_id
    assert.equal(resultA.results[0].action,'inserted')
    await b.query('BEGIN; SET LOCAL ROLE service_role;')
    const pending=b.query(call(sourceB,tag)).then(output=>({output}),error=>({error}))
    const wait=await waitFor(aPid,bPid)
    assert.deepEqual(parse(await root.query(rows(tag))),[],'No uncommitted identity visible')
    await a.query(outcome+';')
    const result=await pending;if('error' in result)throw result.error
    const resultB=parse(result.output),idB=resultB.results[0].player_id
    if(outcome==='COMMIT') {assert.equal(idB,idA);assert.equal(resultB.results[0].action,'updated')}
    else {assert.notEqual(idB,idA);assert.equal(resultB.results[0].action,'inserted')}
    const observed=parse(await b.query(rows(tag)))
    assert.equal(observed.length,sourceB==='nba_draft'?50:1)
    if(sourceA!==sourceB && ![sourceA,sourceB].includes('nba_draft') && outcome==='COMMIT') {
      assert.equal(observed[0].nba_id,'nba-'+tag);assert.equal(observed[0].espn_id,'espn-'+tag)
    }
    // Full draft replacement remains within an uncommitted test transaction.
    // No test commits a replacement of another fixture's draft board.
    await b.query(sourceB==='nba_draft'?'ROLLBACK;':'COMMIT;')
    const afterDraft=await root.query("SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(id,nba_draft_number) ORDER BY id)::text,'')) FROM public.players WHERE nba_draft_number IS NOT NULL;")
    assert.equal(afterDraft,beforeDraft,'Existing draft numbers must be unchanged')
    console.log(JSON.stringify({sourceA,sourceB,outcome,wait,idA,idB,actionB:resultB.results[0].action,
      observedRows:observed.length,existingDraftPreserved:true,secondOutcome:sourceB==='nba_draft'?'ROLLBACK':'COMMIT'}))
    await a.close();await b.close()
  }
} finally {
  const errors=[]
  for(const s of sessions) await s.close().catch(e=>errors.push(e.message))
  for(const tag of cohorts) {
    await root.query(`DELETE FROM public.players WHERE last_name=${quote(tag)};`)
    assert.deepEqual(parse(await root.query(rows(tag))),[])
  }
  await root.close()
  console.log(JSON.stringify({cleanup:'complete',cohorts:cohorts.length,errors}))
  assert.deepEqual(errors,[])
}

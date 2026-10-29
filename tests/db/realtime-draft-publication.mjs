import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const db = process.env.SUPABASE_DB_URL
assert(db && ['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
const prefix = `owned-hints-${randomUUID()}`
const quote = value => `'${String(value).replaceAll("'", "''")}'`

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
const root = new Session('publication')
const user = randomUUID(), member = randomUUID(), league = randomUUID(), season = randomUUID(), draft = randomUUID()
const slot = `draft_${randomUUID().replaceAll('-', '')}`
try {
  await root.query(`BEGIN;
INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(${quote(user)},${quote(user+'@example.test')},'{}');
INSERT INTO public.leagues(id,name,slug,commissioner_id,status) VALUES(${quote(league)},'Publication probe',${quote(league)},${quote(user)},'active');
INSERT INTO public.league_members(id,league_id,user_id,role,team_name) VALUES(${quote(member)},${quote(league)},${quote(user)},'commissioner','Publication');
INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(${quote(season)},${quote(league)},2170,true);
INSERT INTO public.drafts(id,league_id,league_season_id,draft_type,is_mock,created_by_member_id) VALUES(${quote(draft)},${quote(league)},${quote(season)},'auction',true,${quote(member)});
COMMIT;`)
  await root.query(`SELECT slot_name FROM pg_create_logical_replication_slot(${quote(slot)},'pgoutput',true);`)
  await root.query(`BEGIN; UPDATE public.leagues SET name='Publication changed' WHERE id=${quote(league)}; UPDATE public.drafts SET scheduled_at=clock_timestamp() WHERE id=${quote(draft)}; COMMIT;`)
  const result = JSON.parse(await root.query(`SELECT jsonb_build_object('rows',count(*) FILTER(WHERE get_byte(data,0) IN (73,85,68)),
 'bytes',sum(octet_length(data)),
 'draftRows',count(*) FILTER(WHERE get_byte(data,0) IN (73,85,68) AND (get_byte(data,1)::bigint*16777216+get_byte(data,2)*65536+get_byte(data,3)*256+get_byte(data,4))='public.drafts'::regclass::oid),
 'leagueRows',count(*) FILTER(WHERE get_byte(data,0) IN (73,85,68) AND (get_byte(data,1)::bigint*16777216+get_byte(data,2)*65536+get_byte(data,3)*256+get_byte(data,4))='public.leagues'::regclass::oid),
 'hintRows',count(*) FILTER(WHERE get_byte(data,0) IN (73,85,68) AND (get_byte(data,1)::bigint*16777216+get_byte(data,2)*65536+get_byte(data,3)*256+get_byte(data,4))='public.league_change_hints'::regclass::oid))
FROM pg_logical_slot_get_binary_changes(${quote(slot)},NULL,NULL,'proto_version','1','publication_names','supabase_realtime');`))
  assert.equal(result.draftRows, 1)
  assert.equal(result.leagueRows, 1)
  assert.ok(result.hintRows >= 1, 'League invalidation hints must reach logical replication')
  console.log(JSON.stringify(result))
} finally {
  await root.query(`BEGIN; DELETE FROM public.leagues WHERE id=${quote(league)}; DELETE FROM public.league_change_hints WHERE league_id=${quote(league)}; DELETE FROM auth.users WHERE id=${quote(user)}; COMMIT;`)
  await root.close()
}

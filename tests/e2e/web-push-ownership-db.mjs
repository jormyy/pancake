import { spawn } from 'node:child_process'
import { randomUUID,createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const db = process.env.SUPABASE_DB_URL
assert(db && ['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
const prefix = `owned-push55-${randomUUID()}`
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
const list = (values) => values.map(quote).join(',')
const sessions = []
const print = (stage, evidence) => console.log(JSON.stringify({ stage, ...evidence }))

class Session {
  constructor(name) {
    this.pending = null; this.buffer = ''; this.lines = []; this.stderr = ''; this.ended = false
    this.child = spawn('psql', [db, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], {
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
          const failure = error ?? new Error(`Own SQL connection closes (${code}): ${this.stderr}`); failure.code = this.stderr.match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1]; this.pending.reject(failure); this.pending = null
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

const hashes = ['0', '1', '2', '3'].map(char => char.repeat(64));
const keys = ['A'.repeat(87), 'A'.repeat(22)];

async function register(client, owner, endpoint, generation, current, next) {
  const result = await client.query(
    'SELECT * FROM public.register_web_push_atomic($1,$2,$3,$4,$5,$6,$7)',
    [owner, endpoint, ...keys, generation, current, next],
  );
  return result.rows[0];
}

async function clear(client, owner, endpoint, next) {
  const result = await client.query(
    'SELECT * FROM public.clear_web_push_for_user_atomic($1,$2,$3)',
    [owner, endpoint, next],
  );
  return result.rows[0];
}

// Collect rejection immediately so a blocked request cannot cause an unhandled rejection.
const settled = promise => promise.then(value => ({ value }), error => ({ error }));

async function assertBlocked(holder, holderPid, waiterPid, advisory = false) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await holder.query(`
      SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked_by_holder,
             EXISTS (SELECT 1 FROM pg_locks WHERE pid=$2::int AND NOT granted AND locktype='advisory') AS advisory
    `, [holderPid, waiterPid]);
    if (rows[0].blocked_by_holder && (!advisory || rows[0].advisory)) { console.log(JSON.stringify({ actualWait: true, holderPid, waiterPid, advisory: rows[0].advisory })); return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('The second connection never blocks on the expected first connection');
}

async function inspect(client, endpoint) {
  const { rows } = await client.query(`
    SELECT c.generation, c.credential_hash, c.owner_id,
           (SELECT user_id FROM public.web_push_subscriptions WHERE endpoint=c.endpoint) AS delivery_owner
    FROM private.web_push_controls c WHERE c.endpoint=$1
  `, [endpoint]);
  assert.equal(rows.length, 1);
  return rows[0];
}

async function runServerConcurrencyDraft(connect, fixture) {
  const first = await connect();
  const second = await connect();
  const firstPid = (await first.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const secondPid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  assert.notEqual(firstPid, secondPid);
  let completed = 0;
  const endpoint = label => `${fixture.endpointPrefix}${label}`;
  try {
    // An uncommitted clear serializes the absent endpoint before first registration.
    for (const commit of [false, true]) {
      const target = endpoint(`clear-first-${commit}`);
      await first.query('BEGIN');
      const cleared = await clear(first, fixture.ownerA, target, hashes[1]);
      assert.equal(cleared.applied, true);
      const pending = settled(register(second, fixture.ownerA, target, 0, hashes[0], hashes[2]));
      await assertBlocked(first, firstPid, secondPid, true);
      await first.query(commit ? 'COMMIT' : 'ROLLBACK');
      const outcome = await pending;
      if ('error' in outcome) throw outcome.error;
      assert.equal(outcome.value.applied, !commit);
      const state = await inspect(first, target);
      assert.equal(Number(state.generation), 1);
      assert.equal(state.owner_id, commit ? null : fixture.ownerA);
      assert.equal(state.delivery_owner, commit ? null : fixture.ownerA);
      completed++;
    }

    // An uncommitted first registration also serializes an absent-row clear.
    for (const commit of [false, true]) {
      const target = endpoint(`register-first-${commit}`);
      await first.query('BEGIN');
      assert.equal((await register(first, fixture.ownerA, target, 0, hashes[0], hashes[1])).applied, true);
      const pending = settled(clear(second, fixture.ownerA, target, hashes[2]));
      await assertBlocked(first, firstPid, secondPid, true);
      await first.query(commit ? 'COMMIT' : 'ROLLBACK');
      const outcome = await pending;
      if ('error' in outcome) throw outcome.error;
      assert.equal(outcome.value.applied, true);
      const state = await inspect(first, target);
      assert.equal(Number(state.generation), commit ? 2 : 1);
      assert.equal(state.owner_id, null);
      assert.equal(state.delivery_owner, null);
      assert.equal((await register(second, fixture.ownerA, target, 0, hashes[0], hashes[3])).applied, false);
      completed++;
    }

    // Transfer commits before old-owner deletion; deletion must preserve B.
    {
      const owner = fixture.transferBeforeDeleteOwner;
      const target = endpoint('transfer-before-delete');
      assert.equal((await register(first, owner, target, 0, hashes[0], hashes[1])).applied, true);
      await first.query('BEGIN');
      assert.equal((await register(first, fixture.ownerA, target, 1, hashes[1], hashes[2])).applied, true);
      const pending = settled(second.query('DELETE FROM public.profiles WHERE id=$1', [owner]));
      await assertBlocked(first, firstPid, secondPid);
      await first.query('COMMIT');
      const outcome = await pending;
      if ('error' in outcome) throw outcome.error;
      const state = await inspect(first, target);
      assert.equal(state.owner_id, fixture.ownerA);
      assert.equal(state.delivery_owner, fixture.ownerA);
      assert.equal(Number(state.generation), 2);
      completed++;
    }
    for (const commit of [false, true]) {
      const owner = commit ? fixture.deleteBeforeTransferOwner : fixture.deleteRollbackBeforeTransferOwner;
      const target = endpoint(`delete-before-transfer-${commit}`);
      assert.equal((await register(first, owner, target, 0, hashes[0], hashes[1])).applied, true);
      await first.query('BEGIN');
      await first.query('DELETE FROM public.profiles WHERE id=$1', [owner]);
      const pending = settled(register(second, fixture.ownerA, target, 1, hashes[1], hashes[2]));
      await assertBlocked(first, firstPid, secondPid);
      await first.query(commit ? 'COMMIT' : 'ROLLBACK');
      const outcome = await pending;
      if ('error' in outcome) throw outcome.error;
      assert.equal(outcome.value.applied, !commit);
      const state = await inspect(first, target);
      assert.equal(state.owner_id, commit ? null : fixture.ownerA);
      assert.equal(state.delivery_owner, commit ? null : fixture.ownerA);
      assert.equal(Number(state.generation), 2);
      completed++;
    }
    // Profile deletion blocks a register for that same profile before endpoint locks.
    for (const commit of [false, true]) {
      const owner = commit ? fixture.deleteCommitOwner : fixture.deleteRollbackOwner;
      const target = endpoint(`delete-first-${commit}`);
      assert.equal((await register(first, owner, target, 0, hashes[0], hashes[1])).applied, true);
      await first.query('BEGIN');
      assert.equal((await first.query('DELETE FROM public.profiles WHERE id=$1', [owner])).rowCount, 1);
      const pending = settled(register(second, owner, target, 1, hashes[1], hashes[2]));
      await assertBlocked(first, firstPid, secondPid);
      await first.query(commit ? 'COMMIT' : 'ROLLBACK');
      const outcome = await pending;
      if (commit) { assert('error' in outcome); assert.equal(outcome.error?.code, 'P0002'); }
      else {
        if ('error' in outcome) throw outcome.error;
        assert.equal(outcome.value.applied, true);
      }
      const state = await inspect(first, target);
      assert.equal(Number(state.generation), 2);
      assert.equal(state.owner_id, commit ? null : owner);
      assert.equal(state.credential_hash, commit ? null : hashes[2]);
      assert.equal(state.delivery_owner, commit ? null : owner);
      completed++;
    }
    return { completed, connections: 2 };
  } finally {
    // Disconnecting the waiter first releases pending work if an assertion fails.
    await first.query('ROLLBACK').catch(() => {});
    await second.end();
    await first.end();
  }
}

const checkout = fileURLToPath(new URL('../../', import.meta.url))
const names = ['public/register_web_push_atomic.sql','public/clear_web_push_for_user_atomic.sql','private/revoke_deleted_profile_web_push.sql']
print('source-binding', {hashes: Object.fromEntries(names.map(name => [name,createHash('sha256').update(readFileSync(checkout+'supabase/sql/functions/by-name/'+name)).digest('hex')]))})
const root = new Session('inspector')
const users=Array.from({length:6},()=>randomUUID())
const endpointPrefix=`https://fcm.googleapis.com/fcm/send/${prefix}-`
const fixture={ownerA:users[0],deleteCommitOwner:users[1],deleteRollbackOwner:users[2],endpointPrefix,transferBeforeDeleteOwner:users[3],deleteBeforeTransferOwner:users[4],deleteRollbackBeforeTransferOwner:users[5]}
const labels=['clear-first-false','clear-first-true','register-first-false','register-first-true','delete-first-false','delete-first-true','transfer-before-delete','delete-before-transfer-false','delete-before-transfer-true']
const endpoints=labels.map(x=>endpointPrefix+x)
const connect=async()=>{
 const s=new Session('connection-'+sessions.length);sessions.push(s)
 return {end:()=>s.close(),query:async(statement,params=[])=>{
  const expanded=statement.replace(/\$(\d+)/g,(_,n)=>quote(params[Number(n)-1])).trim().replace(/;$/,'')
  if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(expanded)) {await s.query(expanded+';');return {rows:[],rowCount:0}}
  const deletion=/^DELETE/i.test(expanded)
  assert(deletion || /^SELECT/i.test(expanded),'Only intended draft queries execute')
  const query=deletion?`WITH records AS (${expanded} RETURNING id) SELECT COALESCE(json_agg(records),'[]') FROM records;`
   :`SELECT COALESCE(json_agg(records),'[]') FROM (${expanded}) records;`
  const service=expanded.includes('public.register_web_push_atomic(')||expanded.includes('public.clear_web_push_for_user_atomic(')
  const raw=await s.query(service?`SET ROLE service_role; ${query} RESET ROLE;`:query)
  const rows=JSON.parse(raw);return {rows,rowCount:rows.length}
 }}
}
try {
 assert.equal(await root.query(`SELECT count(*) FROM auth.users WHERE id IN (${list(users)});`),'0')
 await root.query(`INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 SELECT id,'authenticated','authenticated',id||'@example.test','x',now(),'{}','{}',now(),now() FROM unnest(ARRAY[${list(users)}]::uuid[]) id;`)
 const result=await runServerConcurrencyDraft(connect,fixture)
 assert.equal(result.completed,9)
 print('actual-nine-connection-probes',{...result,actualServiceRpc:true,actualPrivateInspection:true})
} finally {
 for (const s of sessions) await s.close()
 await root.query(`DELETE FROM auth.users WHERE id IN (${list(users)});
 DELETE FROM private.web_push_controls WHERE endpoint IN (${list(endpoints)});`)
 const result=JSON.parse(await root.query(`SELECT json_build_object('users',(SELECT count(*) FROM auth.users WHERE id IN (${list(users)})),
 'profiles',(SELECT count(*) FROM public.profiles WHERE id IN (${list(users)})),
 'delivery',(SELECT count(*) FROM public.web_push_subscriptions WHERE endpoint IN (${list(endpoints)})),
 'controls',(SELECT count(*) FROM private.web_push_controls WHERE endpoint IN (${list(endpoints)})));`))
 assert(Object.values(result).every(n=>n===0));print('actual-owned-cleanup',result);await root.close()
}

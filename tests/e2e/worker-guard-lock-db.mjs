import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { databaseTarget } from '../../scripts/mutation/waivers/targets.mjs'

const database = databaseTarget().href
const key = randomUUID()
const token = randomUUID()
const sql = query => {
  const result = spawnSync('psql',[database,'-X','-qAt','-v','ON_ERROR_STOP=1'],{ input: query, encoding: 'utf8', timeout: 10000 })
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'SQL failed')
  return result.stdout.trim()
}
let holder
let finished
try {
  sql(`INSERT INTO private.work_items(kind,key,status,lease_token,invocation_key,lease_until,payload) VALUES('process-trades','renewal-${key}','running','${token}','${key}',clock_timestamp()+interval '3 minutes',jsonb_build_object('leaseTest','${key}'));`)
  holder = spawn('psql',[database,'-X','-qAt','-v','ON_ERROR_STOP=1'],{ stdio: ['pipe','pipe','pipe'] })
  finished = new Promise((resolve,reject) => { holder.on('error',reject); holder.on('exit',code => code === 0 ? resolve() : reject(new Error('Lock holder failed'))) })
  await new Promise((resolve,reject) => {
    let output = ''
    holder.stdout.on('data',bytes => { output += bytes; if (output.includes('LEASE_LOCKED')) resolve() })
    holder.on('error',reject)
    holder.stdin.end(`BEGIN; UPDATE private.work_items SET lease_until=clock_timestamp()+interval '3 minutes' WHERE invocation_key='${key}';\n\\echo LEASE_LOCKED\nSELECT pg_sleep(2); ROLLBACK;`)
  })
  const started = performance.now()
  assert.equal(sql(`SET statement_timeout='1s'; SELECT set_config('request.headers',jsonb_build_object('x-pancake-work-key','${key}')::text,false); UPDATE public.players SET nba_team=nba_team WHERE false; SELECT true;` ).split('\n').at(-1),'t')
  const elapsed = performance.now()-started
  assert.ok(elapsed<1000,`Lease guard waits behind a work-row update: ${elapsed} ms`)
  await finished
  assert.equal(sql(`UPDATE private.work_items SET lease_until=clock_timestamp()-interval '1 second' WHERE invocation_key='${key}'; SELECT true;`),'t')
  assert.throws(() => sql(`SET request.headers='${JSON.stringify({ 'x-pancake-work-key': key })}'; UPDATE public.players SET nba_team=nba_team WHERE false;`), /Work lease is no longer current/)
  console.log(JSON.stringify({ passed: 3, guardWhileLeaseLockedMs: elapsed }))
} finally {
  holder?.kill()
  await finished?.catch(() => {})
  sql(`DELETE FROM private.work_items WHERE invocation_key='${key}';`)
}

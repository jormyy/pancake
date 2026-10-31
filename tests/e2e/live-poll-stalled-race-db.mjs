import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { databaseTarget } from '../../scripts/mutation/waivers/targets.mjs'

const database = databaseTarget().href
const sql = query => {
  const result = spawnSync('psql',[database,'-X','-qAt','-v','ON_ERROR_STOP=1'],{ input: query, encoding: 'utf8', timeout: 15000 })
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'SQL failed')
  return result.stdout.trim()
}
const seed = (key,token) => {
  const request = Math.floor(Math.random()*1e9)+1e9
  sql(`DELETE FROM private.work_items WHERE kind='live-poll';
    INSERT INTO private.work_items(kind,key,status,attempts,lease_token,invocation_key,lease_until) VALUES('live-poll','race-${key}','running',1,'${token}','${key}',clock_timestamp()+interval '5 minutes');
    INSERT INTO public.edge_invocations(function_name,request_id,invocation_key,work_item_id,work_lease_token,queued_at)
      SELECT 'live-poll',${request},'${key}',id,'${token}',clock_timestamp()-interval '3 minutes' FROM private.work_items WHERE invocation_key='${key}';`)
}
const holdOpen = (statements,marker,seconds) => {
  const child = spawn('psql',[database,'-X','-qAt','-v','ON_ERROR_STOP=1'],{ stdio: ['pipe','pipe','pipe'] })
  const finished = new Promise((resolve,reject) => { child.on('error',reject); child.on('exit',code => code === 0 ? resolve() : reject(new Error('Lock holder failed'))) })
  const ready = new Promise((resolve,reject) => {
    let output = ''
    child.stdout.on('data',bytes => { output += bytes; if (output.includes(marker)) resolve() })
    child.on('error',reject)
  })
  child.stdin.end(`BEGIN; ${statements}\n\\echo ${marker}\nSELECT pg_sleep(${seconds}); COMMIT;`)
  return { ready, finished }
}
const keys = []
try {
  const startingKey = randomUUID()
  keys.push(startingKey)
  seed(startingKey,randomUUID())
  const worker = holdOpen(`SELECT public.start_work_invocation('${startingKey}','live-poll');`,'WORKER_STARTED',1)
  await worker.ready
  const started = performance.now()
  assert.equal(sql(`SET statement_timeout='1s'; SELECT private.release_stalled_live_poll();`),'0')
  assert.ok(performance.now()-started<1000,'Release waits behind a starting worker')
  await worker.finished
  assert.equal(sql(`SELECT private.release_stalled_live_poll();`),'0')
  assert.equal(sql(`SELECT status FROM private.work_items WHERE invocation_key='${startingKey}';`),'running')

  const releasingKey = randomUUID()
  keys.push(releasingKey)
  seed(releasingKey,randomUUID())
  const release = holdOpen(`SELECT private.release_stalled_live_poll();`,'RELEASED',1)
  await release.ready
  const late = spawnSync('psql',[database,'-X','-qAt','-v','ON_ERROR_STOP=1'],{ input: `SELECT public.start_work_invocation('${releasingKey}','live-poll');`, encoding: 'utf8', timeout: 15000 })
  await release.finished
  assert.notEqual(late.status,0,'A late worker started beside a released lease')
  assert.match(late.stderr,/Work lease is no longer current/)
  assert.equal(sql(`SELECT count(*) FROM public.edge_invocations WHERE invocation_key='${releasingKey}' AND worker_started_at IS NOT NULL;`),'0')
  assert.equal(sql(`SELECT status FROM private.work_items WHERE invocation_key='${releasingKey}';`),'failed')
  console.log(JSON.stringify({ passed: 6 }))
} finally {
  for (const key of keys) sql(`DELETE FROM public.edge_invocations WHERE invocation_key='${key}'; DELETE FROM private.work_items WHERE invocation_key='${key}'; DELETE FROM public.sync_runs WHERE function_name='live-poll' AND started_at>clock_timestamp()-interval '1 minute';`)
}

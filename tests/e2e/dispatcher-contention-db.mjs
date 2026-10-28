import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { databaseTarget } from '../../scripts/mutation/waivers/targets.mjs'

const database = databaseTarget().href
const prefix = `dispatch-contention-${randomUUID()}`
const children = []
const sql = query => {
  const started = performance.now()
  const result = spawnSync('psql', [database, '-XqAt', '-v', 'ON_ERROR_STOP=1'], { input: query, encoding: 'utf8', timeout: 10000 })
  if (result.status !== 0) throw new Error(`SQL fails after ${Math.round(performance.now() - started)} ms: ${result.stderr || result.error?.message || 'SQL failed'}`)
  return result.stdout.trim()
}
async function hold(statement) {
  const child = spawn('psql', [database, '-XqAt', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(child)
  const done = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', code => code === 0 || code === null ? resolve() : reject(new Error('Lock holder failed')))
  })
  done.catch(() => {})
  await new Promise((resolve, reject) => {
    let output = ''
    child.stdout.on('data', bytes => { output += bytes; if (output.includes('CONTENTION_READY')) resolve() })
    child.on('error', reject)
    done.then(() => reject(new Error('Lock holder exits before readiness')), reject)
    child.stdin.write(`BEGIN; ${statement};\n\\echo CONTENTION_READY\n`)
  })
  return async () => { child.stdin.end('ROLLBACK;\n'); await done }
}
try {
  assert.equal(sql("SELECT count(*) FROM private.work_items WHERE status='running' AND lease_until>clock_timestamp()"), '0', 'Run this recipe on an idle private stack')
  const command = sql("SELECT command FROM cron.job WHERE jobname='work-dispatcher'")
  assert.match(command, /statement_timeout\s*=\s*'5s'/)
  assert.match(command, /lock_timeout\s*=\s*'250ms'/)
  const releaseDispatcher = await hold("SELECT pg_advisory_xact_lock(hashtextextended('public.dispatch_work',0))")
  let started = performance.now()
  assert.equal(sql(command), '0')
  const overlapMs = performance.now() - started
  assert.ok(overlapMs < 500, `Overlapping dispatcher waits: ${overlapMs} ms`)
  await releaseDispatcher()
  sql(`INSERT INTO private.work_items(kind,key,status,lease_token,invocation_key,lease_until,payload) SELECT 'process-trades','${prefix}-running-'||n,'running',gen_random_uuid(),gen_random_uuid(),clock_timestamp()+interval '5 minutes',jsonb_build_object('test','${prefix}','slot',n) FROM generate_series(1,4) n; SELECT private.work_enqueue('sync-players','${prefix}-pending-'||n,clock_timestamp()-interval '1 day',jsonb_build_object('test','${prefix}','slot',n)) FROM generate_series(1,24) n`)
  const releaseWorkers = await hold(`UPDATE private.work_items SET lease_until=clock_timestamp()+interval '5 minutes' WHERE key LIKE '${prefix}-running-%'`)
  started = performance.now()
  assert.equal(sql(`SET statement_timeout='1s'; SET lock_timeout='250ms'; SELECT coalesce(private.work_enqueue('process-trades','${prefix}-duplicate',clock_timestamp(),jsonb_build_object('test','${prefix}','slot',1))::text,'skipped')`), 'skipped')
  const enqueueMs = performance.now() - started
  assert.ok(enqueueMs < 250, `Duplicate enqueue waits for a lease update: ${enqueueMs} ms`)
  const releaseNetwork = await hold('LOCK TABLE net.http_request_queue IN SHARE MODE')
  started = performance.now()
  sql(`SET app.supabase_url='http://127.0.0.1:1'; SET app.edge_internal_token='local-contention-test'; ${command}`)
  const dispatchMs = performance.now() - started
  assert.ok(dispatchMs < 5000, `Dispatcher exceeds its budget: ${dispatchMs} ms`)
  assert.equal(sql(`SELECT count(*) FROM private.work_items WHERE key LIKE '${prefix}-running-%' AND status='running'`), '4')
  const failed = Number(sql(`SELECT count(*) FROM private.work_items WHERE key LIKE '${prefix}-pending-%' AND last_error ILIKE '%lock timeout%'`))
  assert.ok(failed > 0 && failed <= 8, `One dispatch retries too many blocked items: ${failed}`)
  assert.equal(Number(sql(`SELECT count(*) FROM private.work_items WHERE key LIKE '${prefix}-pending-%' AND status='pending'`)), 24 - failed)
  await releaseNetwork()
  await releaseWorkers()
  console.log(JSON.stringify({ passed: 11, overlapMs, enqueueMs, dispatchMs }))
} finally {
  for (const child of children) if (child.exitCode === null) child.kill()
  sql(`DELETE FROM private.work_items WHERE key LIKE '${prefix}%'`)
}

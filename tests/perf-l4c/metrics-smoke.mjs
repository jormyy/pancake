import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { config } from '../../scripts/season-sim/common.mjs'
import { localKeys, sql } from '../../scripts/season-sim/local-stack.mjs'
import { setClock } from '../../scripts/season-sim/clock.mjs'

assert.equal(config.project, 'pt4bafableig')
assert.equal(config.prefix, '630')
const keys = localKeys()
process.env.SUPABASE_URL = keys.API_URL
process.env.SUPABASE_DB_URL = keys.DB_URL
const started = new Date().toISOString()
try {
  await sql("ALTER SYSTEM SET log_line_prefix='%m [%p] %a %u@%d '")
  await sql("ALTER SYSTEM SET log_parameter_max_length='0'")
  await sql("ALTER SYSTEM SET log_parameter_max_length_on_error='0'")
  await sql('SELECT pg_reload_conf()')
  await sql(await readFile(new URL('./metrics-setup.sql', import.meta.url), 'utf8'))
  await sql("INSERT INTO perf_lab.metrics_boundaries VALUES('idle','before','2026-10-29T20:30Z'),('idle','after','2026-10-29T21:30Z')")
  await sql('SELECT perf_lab.observe_boundary()')
  assert.equal(await sql('SELECT count(*) FROM perf_lab.metrics_seen'), '0')
  await setClock({ at: '2026-10-29T20:30:00.000Z', rate: 0, install: true })
  await sql('SELECT perf_lab.observe_boundary()')
  assert.equal(await sql('SELECT count(*) FROM perf_lab.metrics_seen'), '1')
  await new Promise(resolve => setTimeout(resolve, 1000))
  const response = await fetch(`${keys.API_URL}/rest/v1/rpc/get_live_poll_work`, { method: 'POST',
    headers: { apikey: keys.ANON_KEY, authorization: `Bearer ${keys.SERVICE_ROLE_KEY}`, 'content-type': 'application/json', 'x-l4c-job': 'live-poll' },
    body: '{}', signal: AbortSignal.timeout(5000) })
  assert.equal(response.status, 200)
  await response.arrayBuffer()
  await setClock({ at: '2026-10-29T21:30:00.000Z', rate: 0 })
  await sql('SELECT perf_lab.observe_boundary()')
  assert.equal(await sql('SELECT count(*) FROM perf_lab.metrics_seen'), '2')
  const captured = spawnSync('docker', ['logs', '--since', started, config.container], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(captured.status, 0)
  const logs = captured.stdout + captured.stderr
  assert.ok(logs.includes('L4C_BOUNDARY'))
  assert.match(logs, /l4c:idle:live-poll.*duration:/)
  assert.match(logs, /l4c:idle:live-poll.*duration:.*get_live_poll_work/)
  console.log('L4c telemetry: native-clock guard, exact boundaries, HTTP job attribution PASS')
} finally {
  await sql('ALTER ROLE authenticator RESET pgrst.db_pre_request')
  await sql("NOTIFY pgrst,'reload config'")
  const restore = await readFile('scripts/season-sim/restore-clock.sql', 'utf8')
  await sql(restore.slice(restore.indexOf('BEGIN;')))
}

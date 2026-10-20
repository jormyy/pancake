import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { open, readFile } from 'node:fs/promises'
import path from 'node:path'
import { delay, laneDirectory, miniRoot, writeJson } from './common.mjs'
import { localKeys, sql } from './local-stack.mjs'
import { setClock } from './clock.mjs'
import { startOrigin } from './origin.mjs'

export async function startRuntime(at, { resume = false } = {}) {
  const keys = localKeys()
  process.env.SUPABASE_URL = keys.API_URL
  process.env.SUPABASE_DB_URL = keys.DB_URL
  const evidence = await laneDirectory(path.join(miniRoot, 'evidence'))
  const token = randomBytes(32).toString('hex')
  const clockAudit = JSON.parse(await sql(await readFile(new URL('./clock-audit.sql', import.meta.url), 'utf8')))
  await writeJson(path.join(evidence, 'clock-audit.json'), clockAudit)
  for (const form of ['current_timestamp', 'current_date', 'current_time', 'localtimestamp', 'localtime', 'timeofday']) assert.equal(clockAudit[form].occurrences, 0, `Uncovered SQL clock form: ${form}`)
  await setClock({ at, rate: 0, install: true })
  const reboundAudit = JSON.parse(await sql(await readFile(new URL('./clock-audit.sql', import.meta.url), 'utf8')))
  await writeJson(path.join(evidence, 'clock-audit-installed.json'), reboundAudit)
  for (const [form, entry] of Object.entries(reboundAudit)) if (form.startsWith('season_sim_native_')) assert.equal(entry['occurrences'], 0, `Native clock binding remains: ${form}`)
  assert.equal(Number(await sql('SELECT extract(epoch FROM now())*1000')), Date.parse(at), 'Database clock must match Edge clock')
  assert.equal(await sql("SELECT current_setting('cron.launch_active_jobs')"), 'off')
  assert.equal(await sql('SELECT count(*) FROM cron.job'), '0')
  await sql(`ALTER DATABASE postgres SET app.supabase_url = 'http://host.lima.internal:56281'; ALTER DATABASE postgres SET app.edge_internal_token = '${token}'`)
  const origin = await startOrigin({ resume })
  const log = await open(path.join(evidence, 'edge.log'), 'a')
  let child
  const stopEdge = async () => { if (child && child.exitCode == null && child.signalCode == null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited } }
  const close = async () => { await stopEdge(); origin.flushCoverage(); await new Promise(resolve => origin.close(resolve)); await log.close() }
  const startEdge = async () => {
    child = spawn('deno', ['run', '--allow-sys=homedir', '--allow-env', '--allow-read', '--allow-write', '--allow-net=127.0.0.1:56221,127.0.0.1:56280,127.0.0.1:56281,localhost:56221', 'scripts/season-sim/edge.mjs'], {
    env: { ...process.env, SUPABASE_SECRET_KEY: keys.SECRET_KEY ?? keys.SERVICE_ROLE_KEY, SUPABASE_ANON_KEY: keys.ANON_KEY, PANCAKE_EDGE_INTERNAL_TOKEN: token }, stdio: ['ignore', log.fd, log.fd],
  })
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode != null) throw new Error(`Edge router exited: ${child.exitCode}. See edge.log`)
    try {
      const response = await fetch('http://127.0.0.1:56281/health')
      ready = response.ok
      if (ready) break
    } catch {}
    await delay(500)
  }
  assert.ok(ready, 'Edge router did not become ready')
  await writeJson(path.join(miniRoot, 'state/runtime.json'), { pid: process.pid, edgePid: child.pid, at })
  }
  try { await startEdge(); return { keys, token, close, stopEdge, startEdge, origin } }
  catch (error) { await close(); throw error }
}

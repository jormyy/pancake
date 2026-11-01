import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import path from 'node:path'
import { delay, directory, loopback, repository } from './common.mjs'

export async function startWorkers(stack, label, ingestionOff = false) {
  loopback(stack.api, [stack.ports.api])
  loopback(stack.db, [stack.ports.db])
  const receipts = path.join(stack.evidence, `${label}-workers.jsonl`)
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, SUPABASE_URL: stack.api, SUPABASE_DB_URL: stack.db,
    PANCAKE_SUPABASE_SECRET_KEY: stack.keys.SERVICE_ROLE_KEY, SUPABASE_ANON_KEY: stack.keys.ANON_KEY, PANCAKE_EDGE_INTERNAL_TOKEN: stack.token,
    GAME_NIGHT_CONFIG: JSON.stringify({ ...stack.ports, functions: path.join(repository, 'supabase/functions'), receipts, ingestionOff }) }
  for (const name of ['NBA_CDN_BASE_URL','NBA_STATS_BASE_URL','NBA_COM_BASE_URL','ESPN_SITE_BASE_URL','ESPN_CAREER_BASE_URL','ESPN_SEARCH_BASE_URL','HASHTAG_BASE_URL','SLEEPER_BASE_URL','EXPO_PUSH_URL','EXPO_RECEIPTS_URL']) env[name] = `http://127.0.0.1:${stack.ports.feed}`
  env.ESPN_LIVE_BASE_URL = `http://127.0.0.1:${stack.ports.feed}/espn`
  const child = spawn('deno', ['run', '--no-lock', '--node-modules-dir=none', '--allow-read', '--allow-write', '--allow-env', '--allow-sys=homedir', `--allow-net=${Object.values(stack.ports).map(port => `127.0.0.1:${port}`).join(',')},0.0.0.0:${stack.ports.edge}`, path.join(directory, 'edge.mjs')], { cwd: repository, env, stdio: ['ignore','pipe','pipe'] })
  const log = createWriteStream(path.join(stack.evidence, `${label}-edge.log`), { mode: 0o600 })
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    if (child.exitCode == null && child.signalCode == null) { const exited = once(child, 'close'); child.kill('SIGTERM'); await exited }
    log.end()
  }
  try {
    let ready = false
    for (let attempt = 0; attempt < 120; attempt++) {
      assert.equal(child.exitCode, null, 'Edge router exits during startup; inspect its log')
      ready = await fetch(`http://127.0.0.1:${stack.ports.edge}/health`).then(response => response.ok).catch(() => false)
      if (ready) break
      await delay(500)
    }
    assert.ok(ready, 'Edge router does not start')
    return { close, receipts }
  } catch (error) { await close(); throw error }
}

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import path from 'node:path'
import { delay, directory, loopback, repository } from './common.mjs'

export async function startPublicFeed(stack, label) {
  const origin = loopback(`http://127.0.0.1:${stack.ports.public}`, [stack.ports.public]).origin
  const feed = loopback(`http://127.0.0.1:${stack.ports.feed}`, [stack.ports.feed]).origin
  const env = { PATH: process.env.PATH, HOME: process.env.HOME,
    GAME_NIGHT_PUBLIC_CONFIG: JSON.stringify({ port: stack.ports.public, legacy: !stack.liveArchitecture }),
    NBA_CDN_BASE_URL: feed, ESPN_LIVE_BASE_URL: `${feed}/espn` }
  const child = spawn('deno', ['run', '--no-lock', '--node-modules-dir=none',
    '--allow-env=GAME_NIGHT_PUBLIC_CONFIG,NBA_CDN_BASE_URL,ESPN_LIVE_BASE_URL,LIVE_SCORES_OFF',
    `--allow-net=127.0.0.1:${stack.ports.feed},127.0.0.1:${stack.ports.public}`,
    path.join(directory, 'public-server.ts')], { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = createWriteStream(path.join(stack.evidence, `${label}-public.log`), { mode: 0o600 })
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    if (child.exitCode == null && child.signalCode == null) { const exited = once(child, 'close'); child.kill('SIGTERM'); await exited }
    log.end()
  }
  try {
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode, null, 'Public route exits during startup; inspect its scoped log')
      ready = await fetch(`${origin}/health`).then(response => response.ok).catch(() => false)
      if (ready) break
      await delay(100)
    }
    assert.ok(ready, 'Public route does not start')
    return { origin, close, health: () => fetch(`${origin}/health`).then(response => response.json()),
      control: value => fetch(`${origin}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }) }
  } catch (error) { await close(); throw error }
}

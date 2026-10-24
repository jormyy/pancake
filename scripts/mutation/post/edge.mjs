import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { lane } from './lane.mjs'

// Owns this lane's `supabase functions serve` process. The real Edge runtime
// container is restarted around every served-path mutant so the worker cannot
// keep a module compiled before the mutation or the restore.
const envFile = `${lane}/edge.env`
const pidFile = `${lane}/edge.pid`
const container = 'supabase_edge_runtime_pt4bapost'
const endpoint = 'http://127.0.0.1:57421/functions/v1/season-boundary'
// The served sync-schedule worker reads the NBA schedule from the fake CDN that
// post-t11-schedule-http.ts listens on (the API port + 70 on the mini's loopback,
// reached from the Lima VM through its host alias). No served function in this
// lane reaches the real NBA CDN.
const nbaCdn = 'http://host.lima.internal:57491/static/json'
const toolEnv = { ...process.env, PATH: `${lane}/bin:${process.env.PATH}`, DOCKER_CONFIG: `${lane}/docker-config` }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function ownEdgePid() {
  if (!existsSync(pidFile)) return null
  const pid = Number(readFileSync(pidFile, 'utf8'))
  const command = spawnSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  if (!command) return null
  assert.ok(command.includes(`functions serve --env-file ${envFile}`), `PID ${pid} is not this lane's Edge server: ${command}`)
  return pid
}

function docker(args) {
  return spawnSync('docker', args, { env: toolEnv, encoding: 'utf8' })
}

function edgeContainer() {
  // The CLI also names the Edge runtime's cache volume after the container.
  const inspected = docker(['inspect', '--type', 'container', container])
  if (inspected.status !== 0) return null
  const [info] = JSON.parse(inspected.stdout)
  assert.equal(info.Name, `/${container}`)
  return info.State.Running ? info : null
}

// Hash of a repository file as the running Edge container sees it.
export function servedFileSha(path) {
  const info = edgeContainer()
  assert.ok(info, 'Edge container is not running')
  const mount = info.Mounts.find(item => item.Source.endsWith('/repo/supabase/functions') || item.Source.endsWith('/supabase/functions'))
  assert.ok(mount, 'Edge container has no functions mount')
  assert.ok(path.startsWith('supabase/functions/'))
  const target = `${mount.Destination}/${path.slice('supabase/functions/'.length)}`
  const hashed = docker(['exec', container, 'sha256sum', target])
  assert.equal(hashed.status, 0, hashed.stderr)
  return hashed.stdout.trim().split(/\s+/)[0]
}

export async function stopEdge() {
  const pid = ownEdgePid()
  if (pid != null) {
    process.kill(pid, 'SIGTERM')
    for (let attempt = 0; ownEdgePid() != null; attempt++) {
      if (attempt > 240) throw new Error(`Edge server ${pid} did not stop`)
      await sleep(250)
    }
  }
  for (let attempt = 0; edgeContainer(); attempt++) {
    if (attempt > 240) throw new Error(`${container} is still running after its serve process stopped`)
    await sleep(250)
  }
}

export async function startEdge() {
  assert.equal(ownEdgePid(), null, 'Stop the running Edge server first')
  mkdirSync(`${lane}/evidence`, { recursive: true })
  writeFileSync(envFile, `PANCAKE_EDGE_INTERNAL_TOKEN=local-database-ci-token\nNBA_CDN_BASE_URL=${nbaCdn}\n`)
  const log = openSync(`${lane}/evidence/edge.log`, 'a')
  const edge = spawn('supabase', ['functions', 'serve', '--env-file', envFile], { env: toolEnv, detached: true, stdio: ['ignore', log, log] })
  writeFileSync(pidFile, String(edge.pid))
  edge.unref()
  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      const response = await fetch(endpoint)
      await response.body?.cancel()
      if ([401, 403].includes(response.status) && edgeContainer()) return edge.pid
    } catch {}
    await sleep(500)
  }
  throw new Error('The real Edge server must reject unauthenticated requests before tests start')
}

export async function restartEdge() {
  await stopEdge()
  return await startEdge()
}

#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdir, readFile, writeFile, cp, symlink, chmod, access, readdir, rm } from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPwaRelease } from '../../tests/e2e/pwa-update-release.mjs'
import { localFixtureEnv } from './local-fetch.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const [action, target] = process.argv.slice(2)
const cleanEnv = { PATH: process.env.PATH, HOME: os.homedir(), TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8', EXPO_NO_DOTENV: '1', CI: '1', VERCEL_ENV: 'development' }
if (process.env.PANCAKE_VERIFY_DOCKER_HOST) {
  assert.match(process.env.PANCAKE_VERIFY_DOCKER_HOST, /^unix:\/\/.+\.sock$/)
  cleanEnv.DOCKER_HOST = process.env.PANCAKE_VERIFY_DOCKER_HOST
}
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const output = (command, args, cwd = repo) => execFileSync(command, args, { cwd, env: cleanEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const birth = pid => { try { return output('ps', ['-p', String(pid), '-o', 'lstart=']) } catch { return '' } }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

export function requireLocal(value, protocol = 'http:') {
  const url = new URL(value)
  assert.equal(url.protocol, protocol)
  assert.equal(url.hostname, '127.0.0.1')
  assert.ok(Number(url.port) > 1024)
  return url
}

export function stackConfig(source, id, base) {
  const portOffsets = { api: 0, db: 1, studio: 2, inbucket: 3, analytics: 6, 'db.pooler': 8 }
  let section = ''
  return source.split('\n').map(line => {
    const header = line.match(/^\[([^\]]+)\]/)
    if (header) section = header[1]
    if (/^project_id\s*=/.test(line)) return `project_id = "${id}"`
    if (/^port\s*=/.test(line) && section in portOffsets) return `port = ${base + portOffsets[section]}`
    if (/^shadow_port\s*=/.test(line)) return `shadow_port = ${base - 1}`
    if (/^inspector_port\s*=/.test(line)) return `inspector_port = ${base + 9}`
    return line
  }).join('\n')
}

async function freeBlock() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 3500) * 10
    const sockets = []
    try {
      for (let offset = -1; offset <= 10; offset++) {
        const server = createServer()
        await new Promise((resolve, reject) => server.once('error', reject).listen(base + offset, '127.0.0.1', resolve))
        sockets.push(server)
      }
      return base
    } catch {} finally { for (const socket of sockets) await new Promise(resolve => socket.close(resolve)) }
  }
  throw new Error('No unused local port block')
}

async function command(command, args, cwd, env, log) {
  const fd = openSync(log, 'a', 0o600)
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, env, stdio: ['ignore', fd, fd] })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code}); see ${log}`)))
    })
  } finally { closeSync(fd) }
}

async function background(run, label, command, args, cwd, env) {
  const fd = openSync(path.join(run.dir, `${label}.log`), 'a', 0o600)
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  run.processes.push({ label, pid: child.pid, birth: birth(child.pid) })
  await save(path.join(run.dir, 'run.json'), run)
  child.unref()
  closeSync(fd)
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(3000) })).ok) return } catch {}
    await pause(1000)
  }
  throw new Error(`Readiness timeout: ${url}`)
}

async function readRun(dir) {
  assert.ok(dir, 'Pass the evidence directory printed by launch')
  const run = await json(path.join(path.resolve(dir), 'run.json'))
  assert.equal(run.repo, repo, 'This run belongs to another checkout')
  assert.equal(run.dir, path.resolve(dir))
  assert.match(run.id, /^pancake-verify-[a-z0-9-]+$/)
  requireLocal(run.url)
  return run
}

async function cleanup(run) {
  const recorded = await json(path.join(run.dir, 'run.json'))
  run.browserStarted ||= recorded.browserStarted || await access(path.join(run.dir, 'browser-config.json')).then(() => true, () => false)
  const errors = []
  for (const process of [...run.processes].reverse()) {
    if (birth(process.pid) !== process.birth || !process.birth) continue
    try {
      globalThis.process.kill(-process.pid, 'SIGTERM')
      for (let attempt = 0; attempt < 30 && birth(process.pid) === process.birth; attempt++) await pause(100)
      if (birth(process.pid) === process.birth) globalThis.process.kill(-process.pid, 'SIGKILL')
    } catch (error) { if (error.code !== 'ESRCH') errors.push(error) }
  }
  if (run.stackStarted) {
    try {
      const config = await readFile(path.join(run.work, 'supabase/config.toml'), 'utf8')
      assert.ok(config.includes(`project_id = "${run.id}"`), 'Stack ownership changed')
      await command('supabase', ['stop', '--no-backup', '--workdir', run.work], repo, cleanEnv, path.join(run.dir, 'cleanup.log'))
    } catch (error) { errors.push(error) }
  }
  if (run.browserStarted) {
    try {
      output('agent-browser', ['--session', run.id, '--config', path.join(run.dir, 'browser-config.json'), 'close'])
      for (let attempt = 0; attempt < 30; attempt++) {
        const sessions = JSON.parse(output('agent-browser', ['session', 'list', '--json'])).data.sessions
        if (!sessions.includes(run.id)) break
        assert.ok(attempt < 29, 'Browser session did not close')
        await pause(100)
      }
    } catch (error) { errors.push(error) }
  }
  assert.equal(errors.length, 0, errors.map(error => error.message).join('\n'))
  run.cleanedAt = new Date().toISOString()
  await save(path.join(run.dir, 'run.json'), run)
  console.log(`CLEANED evidence preserved: ${run.dir}`)
}

async function startWebkit(run) {
  for (const child of run.processes.filter(child => child.label === 'webkit')) {
    if (!child.birth || birth(child.pid) !== child.birth) continue
    process.kill(-child.pid, 'SIGTERM')
    for (let attempt = 0; attempt < 100 && birth(child.pid) === child.birth; attempt++) await pause(100)
    assert.notEqual(birth(child.pid), child.birth, 'Previous task-owned WebKit process did not stop')
  }
  run.processes = run.processes.filter(child => child.label !== 'webkit')
  await rm(path.join(run.dir, 'webkit-port.json'), { force: true })
  await background(run, 'webkit', 'node', [fileURLToPath(new URL('./webkit.mjs', import.meta.url)), run.dir, 'serve'], repo, cleanEnv)
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await access(path.join(run.dir, 'webkit-port.json')).then(() => true, () => false)) { console.log('WebKit ready'); return }
    await pause(100)
  }
  throw new Error('WebKit startup timed out; inspect webkit.log and run cleanup')
}

async function launch() {
  assert.equal(Number(process.versions.node.split('.')[0]), 22, 'Put Node 22 on PATH before launch')
  await access(path.join(repo, 'node_modules/.bin/expo'))
  output('docker', ['info', '--format', '{{.ServerVersion}}'])
  const id = `pancake-verify-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  const dir = path.resolve(target ?? path.join(os.homedir(), 'Documents/pancake-verify-evidence', id))
  assert.ok(!dir.startsWith(repo + path.sep) && dir !== repo, 'Evidence must stay outside the repository')
  await mkdir(dir, { recursive: false, mode: 0o700 }).catch(async error => {
    if (error.code !== 'ENOENT') throw error
    await mkdir(path.dirname(dir), { recursive: true })
    await mkdir(dir, { mode: 0o700 })
  })
  cleanEnv.TMPDIR = path.join(dir, 'runtime-temp')
  await mkdir(cleanEnv.TMPDIR)
  const base = await freeBlock()
  const run = { id, dir, repo, work: path.join(dir, 'work'), sha: output('git', ['rev-parse', 'HEAD']), ports: { api: base, db: base + 1, frontend: base + 10 }, url: `http://127.0.0.1:${base + 10}`, processes: [], stackStarted: false, browserStarted: false }
  await save(path.join(dir, 'run.json'), run)
  console.log(`Preparing isolated verification. Evidence: ${dir}`)
  try {
    await mkdir(run.work)
    const files = output('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
    for (const file of files) {
      if (/(^|\/)(\.env[^/]*|\.temp|\.branches)(\/|$)/.test(file) || /\.(pem|key)$/.test(file)) continue
      await mkdir(path.dirname(path.join(run.work, file)), { recursive: true })
      await cp(path.join(repo, file), path.join(run.work, file))
    }
    await cp(path.join(repo, 'tools/verify'), path.join(run.work, 'tools/verify'), { recursive: true })
    await mkdir(path.join(run.work, 'node_modules/@pancake'), { recursive: true })
    for (const name of await readdir(path.join(repo, 'node_modules'))) {
      if (name === '@pancake') continue
      await symlink(path.join(repo, 'node_modules', name), path.join(run.work, 'node_modules', name))
    }
    await symlink(path.join(run.work, 'core'), path.join(run.work, 'node_modules/@pancake/core'))
    await command('node', [path.join(repo, 'node_modules/typescript/bin/tsc'), '-p', path.join(run.work, 'core/tsconfig.cjs.json')], run.work, cleanEnv, path.join(dir, 'core-build.log'))
    await writeFile(path.join(run.work, 'supabase/config.toml'), stackConfig(await readFile(path.join(repo, 'supabase/config.toml'), 'utf8'), id, base))
    run.stackStarted = true
    await save(path.join(dir, 'run.json'), run)
    await command('supabase', ['start', '--workdir', run.work, '-x', 'studio,imgproxy,vector,logflare,supavisor'], repo, cleanEnv, path.join(dir, 'stack.log'))
    const status = output('supabase', ['status', '--workdir', run.work, '-o', 'env'])
    const values = Object.fromEntries(status.split('\n').flatMap(line => { const m = line.match(/^([A-Z_]+)="(.*)"$/); return m ? [[m[1], m[2]]] : [] }))
    requireLocal(values.API_URL)
    requireLocal(values.DB_URL, 'postgresql:')
    const env = { ...cleanEnv, EXPO_PUBLIC_SUPABASE_URL: values.API_URL, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: values.PUBLISHABLE_KEY ?? values.ANON_KEY, EXPO_PUBLIC_API_URL: `${values.API_URL}/functions/v1/api`, E2E_SUPABASE_URL: values.API_URL, E2E_SUPABASE_PUBLISHABLE_KEY: values.PUBLISHABLE_KEY ?? values.ANON_KEY, E2E_PANCAKE_SUPABASE_SECRET_KEY: values.SECRET_KEY ?? values.SERVICE_ROLE_KEY, SUPABASE_DB_URL: values.DB_URL, E2E_API_BASE_URL: `${values.API_URL}/functions/v1/api`, E2E_FRONTEND_URL: run.url, E2E_SEED_RUN_ID: String(Date.now()), E2E_ADMIN_SECRET: randomUUID(), PANCAKE_EDGE_INTERNAL_TOKEN: randomUUID(), PANCAKE_RELEASE_SHA: run.sha, EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH: '1' }
    await save(path.join(dir, 'local-env.json'), env)
    await writeFile(path.join(dir, 'functions.env'), `E2E_ADMIN_SECRET=${env.E2E_ADMIN_SECRET}\nPANCAKE_EDGE_INTERNAL_TOKEN=${env.PANCAKE_EDGE_INTERNAL_TOKEN}\n`, { mode: 0o600 })
    output('psql', [env.SUPABASE_DB_URL, '-X', '-v', 'ON_ERROR_STOP=1', '-c', "select cron.unschedule(jobid) from cron.job;"])
    await background(run, 'functions', 'supabase', ['functions', 'serve', '--workdir', run.work, '--env-file', path.join(dir, 'functions.env')], repo, env)
    await command('npm', ['run', 'e2e:seed'], run.work, localFixtureEnv(env), path.join(dir, 'seed.log'))
    await chmod(path.join(run.work, 'tests/e2e-state.json'), 0o600)
    await command('node', [path.join(run.work, 'tools/verify/fixture.mjs'), dir], run.work, localFixtureEnv(env), path.join(dir, 'fixture.log'))
    console.log('Seed ready. Building the local web app.')
    await command('npm', ['run', 'build:web:release'], run.work, env, path.join(dir, 'build.log'))
    await command('node', [path.join(run.work, 'tools/verify/enrich.mjs'), dir], run.work, localFixtureEnv(env), path.join(dir, 'enrich.log'))
    await command('node', [path.join(run.work, 'scripts/stamp-release-provenance.mjs')], run.work, env, path.join(dir, 'build.log'))
    await background(run, 'web', 'node', [path.join(repo, 'tests/e2e/static-web-server.mjs'), `--root=${path.join(run.work, 'dist')}`, `--port=${run.ports.frontend}`, '--host=127.0.0.1'], run.work, env)
    await waitFor(`${run.url}/sign-in`)
    run.readyAt = new Date().toISOString()
    await save(path.join(dir, 'run.json'), run)
    await doctor(run)
    console.log(`READY ${run.url} credentials: ${path.join(run.work, 'tests/e2e-state.json')} evidence: ${dir}`)
  } catch (error) { await cleanup(run); throw error }
}

export async function refreshAppSources(source, work, files) {
  for (const root of ['app', 'components', 'constants', 'contexts', 'hooks', 'lib', 'types', 'core', 'public', 'scripts', 'supabase/functions']) {
    await rm(path.join(work, root), { recursive: true, force: true })
  }
  for (const file of files) {
    if (/(^|\/)(\.env[^/]*|\.temp|\.branches)(\/|$)/.test(file) || /\.(pem|key)$/.test(file)) continue
    try { await access(path.join(source, file)) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    await mkdir(path.dirname(path.join(work, file)), { recursive: true })
    await cp(path.join(source, file), path.join(work, file))
  }
}

async function rebuild(run) {
  await doctor(run)
  assert.equal(run.work, path.join(run.dir, 'work'))
  const files = output('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', 'app', 'components', 'constants', 'contexts', 'hooks', 'lib', 'types', 'core', 'public', 'scripts', 'supabase/functions']).split('\0').filter(Boolean)
  await refreshAppSources(repo, run.work, files)
  const env = await json(path.join(run.dir, 'local-env.json'))
  run.sha = output('git', ['rev-parse', 'HEAD'])
  env.PANCAKE_RELEASE_SHA = run.sha
  await save(path.join(run.dir, 'local-env.json'), env)
  await save(path.join(run.dir, 'run.json'), run)
  await rm(path.join(run.work, 'core/cjs'), { recursive: true, force: true })
  await command('node', [path.join(repo, 'node_modules/typescript/bin/tsc'), '-p', path.join(run.work, 'core/tsconfig.cjs.json')], run.work, env, path.join(run.dir, 'core-build.log'))
  await command('npm', ['run', 'build:web:release'], run.work, env, path.join(run.dir, 'rebuild.log'))
  await command('node', [path.join(repo, 'tools/verify/enrich.mjs'), run.dir], run.work, localFixtureEnv(env), path.join(run.dir, 'enrich.log'))
  await command('node', [path.join(run.work, 'scripts/stamp-release-provenance.mjs')], run.work, env, path.join(run.dir, 'rebuild.log'))
  await doctor(run)
}

async function doctor(run) {
  assert.ok(!run.cleanedAt, 'This run has been cleaned up')
  for (const process of run.processes) assert.equal(birth(process.pid), process.birth, `${process.label} process changed or stopped`)
  const env = await json(path.join(run.dir, 'local-env.json'))
  requireLocal(env.E2E_SUPABASE_URL)
  requireLocal(env.SUPABASE_DB_URL, 'postgresql:')
  const config = await readFile(path.join(run.work, 'supabase/config.toml'), 'utf8')
  assert.ok(config.includes(`project_id = "${run.id}"`))
  const release = await (await fetch(`${run.url}/release-provenance.json`)).json()
  assert.equal(release.commitSha, run.sha)
  await readPwaRelease(path.join(run.work, 'dist'))
  const health = await fetch(`${env.E2E_SUPABASE_URL}/auth/v1/health`, { headers: { apikey: env.E2E_SUPABASE_PUBLISHABLE_KEY } })
  assert.ok(health.ok, 'Local auth is unhealthy')
  const edge = await fetch(`${env.E2E_API_BASE_URL}/health`, { headers: { apikey: env.E2E_SUPABASE_PUBLISHABLE_KEY } })
  assert.ok(edge.ok && (await edge.json()).ok, 'Local Edge API is unhealthy')
  const schema = output('psql', [env.SUPABASE_DB_URL, '-XAt', '-c', 'select count(*) from supabase_migrations.schema_migrations'])
  const migrations = (await readdir(path.join(repo, 'supabase/migrations'))).filter(file => /^\d+_.+\.sql$/.test(file))
  assert.equal(Number(schema), migrations.length, 'The stack must include every checkout migration')
  const fixtures = await json(path.join(run.dir, 'fixture.json'))
  assert.ok(fixtures.memberId && fixtures.benchPlayerId && fixtures.currentWeek)
  assert.match(fixtures.leagueId, /^[a-f0-9-]{36}$/)
  const count = output('psql', [env.SUPABASE_DB_URL, '-XAt', '-c', `select count(distinct member_id) from roster_players where league_id='${fixtures.leagueId}'`])
  assert.ok(Number(count) >= 2, 'Expected two populated rosters')
  console.log(`HEALTHY ${run.url} revision ${run.sha.slice(0, 8)} migrations ${schema}; seeded login and lineup available`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const main = action === 'launch' ? launch() : action === 'doctor' ? readRun(target).then(doctor) : action === 'cleanup' ? readRun(target).then(cleanup) : action === 'rebuild' ? readRun(target).then(rebuild) : action === 'webkit' ? readRun(target).then(startWebkit) : action === 'trade-player-stats' ? readRun(target).then(run => command('node', [fileURLToPath(new URL('./trade-player-stats.mjs', import.meta.url)), run.dir], repo, cleanEnv, path.join(run.dir, 'trade-player-stats.log'))) : Promise.reject(new Error('Usage: launch.sh [new-evidence-directory] | doctor.sh EVIDENCE | cleanup.sh EVIDENCE | run.mjs webkit EVIDENCE | run.mjs trade-player-stats EVIDENCE'))
  main.catch(error => { console.error(error.message); process.exitCode = 1 })
}

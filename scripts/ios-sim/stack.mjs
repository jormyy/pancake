import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { sourceSnapshot } from './build.mjs'
import { apiUrl, args, digest, home, internalToken, json, localUrl, lock, pause, project, readJson, ready, repo, run } from './common.mjs'
import { requireCurrentSeed, seed } from './seed.mjs'

const stackRoot = path.join(home, 'stack')
const statePath = path.join(stackRoot, 'local-stack.json')

export async function connectStack(workdir) {
  if (workdir) {
    const directory = path.resolve(workdir)
    const config = await readFile(path.join(directory, 'supabase/config.toml'), 'utf8')
    const targetProject = /^project_id = "([a-zA-Z0-9_-]+)"/m.exec(config)?.[1]
    assert.ok(targetProject, 'The requested local stack has no project ID')
    const status = JSON.parse(await run('supabase', ['status', '--workdir', directory, '-o', 'json']))
    localUrl(status.API_URL)
    const stack = { project: targetProject, url: status.API_URL,
      anonKey: status.PUBLISHABLE_KEY ?? status.ANON_KEY, serviceKey: status.SECRET_KEY ?? status.SERVICE_ROLE_KEY }
    await ready(`${stack.url}/auth/v1/health`)
    const fixture = await seed({ stack, snapshot: repo, directory: path.join(home, 'private-seeds', digest(directory)) })
    return { ...stack, fixture }
  }
  const state = await readJson(statePath)
  assert.equal(state?.project, project, 'Start the shared local stack before capturing')
  localUrl(state.url, 57121)
  const fixture = await readJson(path.join(stackRoot, 'seed/complete.json'))
  assert.ok(fixture?.rosterPlanTrade, 'The shared local stack needs its complete fixture')
  requireCurrentSeed(fixture)
  await ready(`${state.url}/auth/v1/health`)
  return { ...state, fixture }
}

export function stackConfig(source) {
  return source.replace(/^project_id = .*$/m, `project_id = "${project}"`)
    .replace(/\b543(\d\d)\b/g, '571$1')
    .replace('inspector_port = 8083', 'inspector_port = 57183')
    .replace(/(\[db.migrations\]\s*[^[]*?enabled = )true/, '$1false')
    .replace(/(\[db.seed\]\s*[^[]*?enabled = )true/, '$1false')
    .replace(/(\[(?:studio|analytics)\]\s*[^[]*?enabled = )true/g, '$1false')
    .replace('pancake-local-edge-auth-probe-token', internalToken)
}

export async function copyStackSources(snapshot, destination) {
  for (const directory of ['migrations', 'functions']) {
    const target = path.join(destination, 'supabase', directory)
    await rm(target, { recursive: true, force: true })
    await cp(path.join(snapshot, 'supabase', directory), target, { recursive: true })
  }
}

async function stopFunctions(state) {
  if (!state?.functionsPid) return
  const command = await run('ps', ['-p', String(state.functionsPid), '-o', 'command=']).catch(() => '')
  if (command.includes('supabase functions serve') && command.includes(stackRoot)) {
    process.kill(state.functionsPid, 'SIGTERM')
    for (let i = 0; i < 40; i++) {
      try { process.kill(state.functionsPid, 0) } catch { return }
      await pause(250)
    }
    throw new Error('Owned Edge Functions process did not stop')
  }
}

export async function startStack({ reset = false } = {}) {
  return lock(path.join(home, 'stack.lock'), async () => {
    await mkdir(path.join(stackRoot, 'supabase'), { recursive: true })
    let state = await readJson(statePath)
    if (state) {
      assert.equal(state.project, project)
      localUrl(state.url, 57121)
    }
    if (reset) {
      await stopFunctions(state)
      if (state) await run('supabase', ['stop', '--workdir', stackRoot, '--no-backup'])
      await rm(path.join(stackRoot, 'seed'), { recursive: true, force: true })
      await rm(statePath, { force: true })
      state = null
    }
    const { snapshot } = await sourceSnapshot()
    const migrationFiles = (await run('git', ['ls-files', 'supabase/migrations'])).split('\n').filter(Boolean)
    const migrationHash = digest((await Promise.all(migrationFiles.map(file => readFile(path.join(repo, file))))).map(contents => digest(contents)).join(':'))
    assert.ok(!state || state.migrationHash === migrationHash, 'Shared schema differs. Stop the users of this stack before using start --reset.')
    await stopFunctions(state)
    await copyStackSources(snapshot, stackRoot)
    if (!state) {
      await writeFile(path.join(stackRoot, 'supabase/config.toml'), stackConfig(await readFile(path.join(repo, 'supabase/config.toml'), 'utf8')))
    }
    await mkdir(path.join(stackRoot, 'types'), { recursive: true })
    await cp(path.join(snapshot, 'types/database.ts'), path.join(stackRoot, 'types/database.ts'))
    assert.match(await readFile(path.join(stackRoot, 'supabase/config.toml'), 'utf8'), new RegExp(`project_id = "${project}"`))
    state = { ...state, project, url: apiUrl, migrationHash, functionsPid: null }
    await json(statePath, state)
    process.stdout.write('Starting the isolated shared local stack.\n')
    await run('supabase', ['start', '--workdir', stackRoot, '-x', 'studio,imgproxy,vector,logflare,supavisor,edge-runtime,postgres-meta,mailpit'])
    await run('docker', ['exec', `supabase_db_${project}`, 'psql', '-X', '-U', 'supabase_admin', '-d', 'postgres', '-c', "ALTER SYSTEM SET cron.launch_active_jobs = 'off'"])
    await run('docker', ['exec', `supabase_db_${project}`, 'psql', '-X', '-U', 'supabase_admin', '-d', 'postgres', '-c', 'SELECT pg_reload_conf()'])
    const configFile = path.join(stackRoot, 'supabase/config.toml')
    await writeFile(configFile, (await readFile(configFile, 'utf8')).replace(/(\[db.migrations\]\s*[^[]*?enabled = )false/, '$1true'))
    await run('supabase', ['migration', 'up', '--local', '--workdir', stackRoot])
    await run('docker', ['exec', `supabase_db_${project}`, 'psql', '-X', '-U', 'supabase_admin', '-d', 'postgres', '-c', 'SELECT cron.unschedule(jobid) FROM cron.job'])
    const status = JSON.parse(await run('supabase', ['status', '--workdir', stackRoot, '-o', 'json']))
    localUrl(status.API_URL, 57121)
    state = { ...state, project, url: apiUrl, anonKey: status.PUBLISHABLE_KEY ?? status.ANON_KEY, serviceKey: status.SECRET_KEY ?? status.SERVICE_ROLE_KEY, migrationHash }
    await json(statePath, state)
    const alive = state.functionsPid && (await run('ps', ['-p', String(state.functionsPid), '-o', 'command=']).catch(() => '')).includes(stackRoot)
    if (!alive) {
      const log = await open(path.join(stackRoot, 'functions.log'), 'a')
      await writeFile(path.join(stackRoot, 'functions.env'), `PANCAKE_EDGE_INTERNAL_TOKEN=${internalToken}\nE2E_ADMIN_SECRET=pancake-ios-local-admin-token\n`, { mode: 0o600 })
      const child = spawn('supabase', ['functions', 'serve', '--workdir', stackRoot, '--env-file', path.join(stackRoot, 'functions.env')], { cwd: stackRoot, detached: true, stdio: ['ignore', log.fd, log.fd] })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      state.functionsPid = child.pid
      child.unref()
      await log.close()
      await json(statePath, state)
    }
    await ready(`${apiUrl}/auth/v1/health`)
    const edgeStarted = Date.now()
    let edgeReady = false
    while (Date.now() - edgeStarted < 120000) {
      const response = await fetch(`${apiUrl}/functions/v1/api`, { signal: AbortSignal.timeout(3000) }).catch(() => null)
      if (response && [200, 400, 401, 404, 405].includes(response.status)) { edgeReady = true; break }
      await pause(500)
    }
    assert.ok(edgeReady, 'Local Edge Functions are unavailable. Inspect the owned functions.log.')
    const seeded = await seed({ stack: state, snapshot, directory: path.join(stackRoot, 'seed') })
    await json(path.join(stackRoot, 'seeded-logins.json'), { url: apiUrl, anonKey: state.anonKey, password: seeded.password, users: seeded.users.map(user => ({ email: user.email, team: user.teamName })), leagueId: seeded.leagueId })
    process.stdout.write(`Local stack ready. Connection values: ${path.join(stackRoot, 'seeded-logins.json')}\n`)
    return { ...state, fixture: seeded }
  })
}

async function stopStack() {
  return lock(path.join(home, 'stack.lock'), async () => {
    const state = await readJson(statePath)
    assert.equal(state?.project, project, 'No owned shared stack to stop')
    await stopFunctions(state)
    await run('supabase', ['stop', '--workdir', stackRoot])
    await json(statePath, { ...state, functionsPid: null })
  })
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = args(process.argv.slice(3), ['reset'])
  const command = process.argv[2]
  if (command === 'start') startStack({ reset: options.reset === true }).catch(error => { console.error(error); process.exitCode = 1 })
  else if (command === 'stop') stopStack().catch(error => { console.error(error); process.exitCode = 1 })
  else { process.stderr.write('Usage: node scripts/ios-sim/stack.mjs start [--reset] | stop\n'); process.exitCode = 2 }
}

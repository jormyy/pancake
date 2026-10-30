import assert from 'node:assert/strict'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { labRoot, project, requireMini } from '../../scripts/perf-lab/common.mjs'
import { localKeys, sql } from '../../scripts/perf-lab/database.mjs'
import { command } from '../../scripts/perf-lab/process.mjs'
import { certificate } from '../../scripts/perf-lab/build.mjs'
import { captureServer } from '../../scripts/perf-lab/capture.mjs'
import { beginConcurrentRun } from './l1-realtime-concurrency.mjs'
import { setupRequest } from './l1-realtime-setup-retry.mjs'

await requireMini()
assert.equal(project, 'pt4bafablel1')
const clientsOnly = process.argv[2] === 'clients'
const progress = value => writeFile(`${labRoot}/verify-progress.json`, JSON.stringify({ pid: process.pid, ...value, at: new Date().toISOString() }))
await progress({ status: 'preparing-concurrent' })
const release = await beginConcurrentRun()
const startedAt = new Date().toISOString()
const steps = []
const setupRetries = []
const record = async (name, action) => {
  await progress({ status: 'running', step: name, steps })
  const started = performance.now()
  await action()
  steps.push({ name, status: 'pass', wallMs: performance.now() - started })
}
try {
  const keys = await localKeys()
  const { origin } = JSON.parse(await readFile(`${labRoot}/runtime-ready.json`, 'utf8'))
  const tls = await certificate()
  const authProbe = async () => (await Promise.all(Array.from({ length: 20 }, async () => {
    const response = await setupRequest(`${keys.API_URL}/auth/v1/admin/users?page=1&per_page=1`, {
      headers: { apikey: keys.ANON_KEY, Authorization: `Bearer ${keys.SERVICE_ROLE_KEY}` }, signal: AbortSignal.timeout(20000),
    }, { operation: 'auth-probe', retries: setupRetries })
    await response.body?.cancel()
    return response.status
  }))).every(status => status === 200)
  const repairDns = async () => {
    const logs = await command('docker', ['logs', '--since', startedAt, 'supabase_auth_pt4bafablel1'])
    if (!(logs.stdout + logs.stderr).split('\n').some(line => line.includes('supabase_db_pt4bafablel1') && /timeout/i.test(line))) return false
    const inspected = await command('docker', ['inspect', '--format', '{"id":{{json .Id}},"networks":{{json .NetworkSettings.Networks}}}', 'supabase_db_pt4bafablel1'])
    const database = JSON.parse(inspected.stdout)
    const addresses = Object.values(database.networks).map(network => network.IPAddress)
    assert.equal(addresses.length, 1)
    const address = addresses[0]
    assert.match(address, /^172\.\d+\.\d+\.\d+$/)
    for (const service of ['auth', 'rest', 'realtime']) await command('docker', ['exec', '--user', '0', `supabase_${service}_pt4bafablel1`,
      'sh', '-c', `echo '${address} supabase_db_pt4bafablel1' >> /etc/hosts`])
    await writeFile(`${labRoot}/dns-workaround.json`, JSON.stringify({ at: new Date().toISOString(), databaseId: database.id, address, reason: 'Owned Auth database DNS timeout after the clean restart' }), { mode: 0o600 })
    return true
  }
  await record('auth-after-clean-restart', async () => {
    if (!await authProbe()) assert.ok(await repairDns(), 'Auth failures must be diagnosed before continuing')
    assert.ok(await authProbe(), 'The owned Auth service must serve database requests')
  })
  const browserCheck = args => command(process.execPath, args, { timeout: 300000 })
  if (!clientsOnly) {
    await record('seven-surfaces-two-devices', () => browserCheck(['tests/db/l1-live-surfaces.mjs']))
  }
  for (const [version, suffix, commit] of [
    ['2.10.2', '2102', '892b6bcabb06c8a2b99d12e58ae13d86355afb8e'],
    ['2.11', '211', '1e696f2506b0204cc4e744981e572c6d7964f660'],
    ['2.11.1', '2111', '952580ce3204598d1fd120b3f121d166c7626028'],
  ]) await record(`build-release-${version}`, async () => {
    const existing = await readFile(`${labRoot}/web-release${suffix}/l1-release.json`, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error })
    if (existing?.commit === commit && existing.version === version && !existing.sharedCacheFix) return
    const source = `${labRoot}/release${suffix}-source`
    await mkdir(source, { recursive: true })
    await command('git', ['archive', '--format=tar', '--output', `${labRoot}/release${suffix}.tar`, commit])
    await command('tar', ['-xf', `${labRoot}/release${suffix}.tar`, '-C', source])
    await rm(`${source}/node_modules`, { recursive: true, force: true })
    await command('cp', ['-c', '-R', 'node_modules', `${source}/node_modules`], { timeout: 180000 })
    const temporary = `${labRoot}/build-cache-${suffix}`
    await mkdir(temporary, { recursive: true })
    const env = { ...process.env, EXPO_NO_DOTENV: '1', EXPO_OFFLINE: '1', EXPO_NO_TELEMETRY: '1', PANCAKE_FETCH_PREDECESSOR: '0', VERCEL_ENV: 'development', CI: '1',
      EXPO_PUBLIC_SUPABASE_URL: origin, EXPO_PUBLIC_API_URL: `${origin}/functions/v1/api`, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: keys.ANON_KEY, TMPDIR: temporary }
    await command(process.execPath, ['node_modules/expo/bin/cli', 'export', '--platform', 'web', '--clear', '--max-workers', '2'], { cwd: source, env, timeout: 240000 })
    await rm(`${labRoot}/web-release${suffix}`, { recursive: true, force: true })
    await cp(`${source}/dist`, `${labRoot}/web-release${suffix}`, { recursive: true })
    await writeFile(`${labRoot}/web-release${suffix}/l1-release.json`, JSON.stringify({ commit, version }))
  })
  for (const [version, directory] of [['2.9.1', 'web-release291'], ['2.10.2', 'web-release2102'], ['2.11', 'web-release211'], ['2.11.1', 'web-release2111']]) {
    await record(`released-client-${version}`, async () => {
      const server = await captureServer({ root: `${labRoot}/${directory}`, evidence: `${labRoot}/evidence`, port: 62285, host: '127.0.0.1', key: tls.key, cert: tls.cert })
      try { await browserCheck(['tests/db/l1-realtime-browser.mjs', origin.replace(':62284', ':62285'), version]) }
      finally { await server.close() }
    })
  }
  for (const [name, file] of clientsOnly ? [] : [['writer-routing-and-rls', 'tests/db/l1-live-broadcast.sql'], ['three-season-sql', 'tests/db/three-season-simulation.sql']]) {
    await record(name, async () => { await sql(await readFile(file, 'utf8')) })
  }
  await record('retention', async () => { await command(process.execPath, ['tests/db/l1-realtime-retention.mjs'], { timeout: 60000 }) })
  const file = clientsOnly ? 'clients-2111.json' : 'verify-2111.json'
  await writeFile(`${labRoot}/evidence/${file}`, JSON.stringify({ status: 'pass', steps, setupRetries, concurrentLanes: true, measurementLock: false, source: (await command('git', ['rev-parse', 'HEAD'])).stdout.trim() }))
  await progress({ status: clientsOnly ? 'clients-verified' : 'verified', steps })
} catch (error) {
  await progress({ status: 'failed', steps, error: String(error.message).replace(/eyJ[\w.-]+/g, '[redacted]').slice(0, 1200) })
  throw error
} finally { await release() }

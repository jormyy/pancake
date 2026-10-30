import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const root = '/tmp/pancake-int214/l1'
const checkout = `${root}/repo`
assert.equal(process.versions.node.split('.')[0], '22')
assert.equal(process.env.DOCKER_CONTEXT, 'desktop-linux')
assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: source, encoding: 'utf8' }).trim(), 'work/release-2.14')
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
const env = { ...process.env, PERF_LAB_PROJECT: 'pt4bafableint', PERF_LAB_PORT_PREFIX: '650', PERF_LAB_LANE: 'release-214',
  PERF_LAB_ON_MINI: '1', PERF_LAB_TLS_SELF_SIGNED: '1', EXPO_NO_DOTENV: '1', EXPO_OFFLINE: '1', EXPO_NO_TELEMETRY: '1' }
Object.assign(process.env, env)
const run = (file, args, options = {}) => execFileSync(file, args, { cwd: checkout, env, stdio: 'inherit', ...options })
const mode = process.argv[2]
assert.ok(['prepare', 'build', 'serve', 'verify'].includes(mode))

if (mode === 'prepare') {
  const runtime = await readFile(`${root}/runtime-ready.json`, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null })
  assert.equal(runtime, null, 'Stop the owned L1 runtime before preparing another release head')
  await mkdir(`${root}/evidence`, { recursive: true })
  const existing = await readFile(`${checkout}/.git`, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null })
  if (existing) execFileSync('git', ['worktree', 'remove', '--force', checkout], { cwd: source, stdio: 'inherit' })
  execFileSync('git', ['worktree', 'add', '--detach', checkout, head], { cwd: source, stdio: 'inherit' })
  execFileSync('cp', ['-c', '-R', `${source}/node_modules`, `${checkout}/node_modules`])
  const configPath = '/tmp/pancake-int214/stack/supabase/config.toml'
  const hostname = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim().toLowerCase() + '.local'
  const config = (await readFile(configPath, 'utf8')).replace(/^#?\s*jwt_issuer = .*$/m, `jwt_issuer = "https://${hostname}:65084/auth/v1"`)
  await writeFile(configPath, config)
  await writeFile(`${checkout}/supabase/config.toml`, config)
  const commonFile = `${checkout}/scripts/perf-lab/common.mjs`
  let common = await readFile(commonFile, 'utf8')
  common = common.replace('path.join(homedir(), target.relativeRoot)', JSON.stringify(root))
    .replace(/export async function requireMini\(\) \{[\s\S]*?\n\}/, `export async function requireMini() {
  assert.equal(process.env.DOCKER_CONTEXT, 'desktop-linux')
  assert.equal(project, 'pt4bafableint')
  assert.equal(ports.api, 65021)
  assert.equal(await realpath(sourceRoot), await realpath(${JSON.stringify(checkout)}))
  assert.equal(process.versions.node.split('.')[0], '22')
}`)
  await writeFile(commonFile, common)
  const socket = execFileSync('docker', ['context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}'], { env, encoding: 'utf8' }).trim()
  assert.ok(socket.startsWith('unix://'))
  for (const name of (await readdir(`${checkout}/tests/db`)).filter(name => /^l1-.*\.mjs$/.test(name) && name !== path.basename(fileURLToPath(import.meta.url)))) {
    const file = `${checkout}/tests/db/${name}`
    const original = await readFile(file, 'utf8')
    const relocated = original.replaceAll('pt4bafablel1', 'pt4bafableint').replaceAll(/622(?=\d{2})/g, '650')
      .replaceAll("path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-l1/evidence/retention.json')", JSON.stringify(`${root}/evidence/retention.json`))
      .replaceAll("path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-l1/evidence')", JSON.stringify(`${root}/evidence`))
      .replaceAll("path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-l1')", JSON.stringify(root))
      .replaceAll("path.join(homedir(), 'pancake-t_4ba51e0d/lima/pancake-dev/sock/docker.sock')", JSON.stringify(socket.slice(7)))
    await writeFile(file, relocated)
  }
  await writeFile(`${root}/source.json`, JSON.stringify({ head, project: 'pt4bafableint', api: 65021, db: 65022 }))
  console.log(`Prepared isolated L1 harness at ${checkout}`)
  process.exit(0)
}

assert.equal(JSON.parse(await readFile(`${root}/source.json`, 'utf8')).head, head, 'Prepare the harness again after changing the release head')
process.chdir(checkout)
const { localKeys, sql } = await import(`${checkout}/scripts/perf-lab/database.mjs`)
const { certificate, buildWeb } = await import(`${checkout}/scripts/perf-lab/build.mjs`)
const keys = await localKeys()
const tls = await certificate()

if (mode === 'build') {
  const realtime = await readFile('lib/realtime.ts')
  try {
    await writeFile('lib/realtime.ts', execFileSync('git', ['show', '952580ce:lib/realtime.ts'], { cwd: source }))
    await buildWeb(keys, tls)
    await rm(`${root}/web-baseline`, { recursive: true, force: true })
    await cp(`${root}/web-export`, `${root}/web-baseline`, { recursive: true })
    await writeFile('lib/realtime.ts', realtime)
    await buildWeb(keys, tls)
  } finally { await writeFile('lib/realtime.ts', realtime) }
  await writeFile(`${root}/evidence/build-2111.json`, JSON.stringify({ baselineCommit: '952580ce3204598d1fd120b3f121d166c7626028', candidateCommit: head, sharedCacheFix: true }))
  for (const [version, suffix, commit] of [
    ['2.9.1', '291', '04177a1b8f25f4eb0b72f93591ce2967ab00a78c'],
    ['2.10.2', '2102', '892b6bcabb06c8a2b99d12e58ae13d86355afb8e'],
    ['2.11', '211', '1e696f2506b0204cc4e744981e572c6d7964f660'],
    ['2.11.1', '2111', '952580ce3204598d1fd120b3f121d166c7626028'],
  ]) {
    const marker = await readFile(`${root}/web-release${suffix}/l1-release.json`, 'utf8').then(JSON.parse, error => { if (error.code !== 'ENOENT') throw error; return null })
    if (marker?.commit === commit && marker.version === version) continue
    const legacy = `${root}/release${suffix}-source`
    await rm(legacy, { recursive: true, force: true })
    await mkdir(legacy, { recursive: true })
    run('git', ['archive', '--format=tar', '--output', `${root}/release${suffix}.tar`, commit])
    run('tar', ['-xf', `${root}/release${suffix}.tar`, '-C', legacy])
    execFileSync('cp', ['-c', '-R', `${source}/node_modules`, `${legacy}/node_modules`])
    run(process.execPath, ['node_modules/expo/bin/cli', 'export', '--platform', 'web', '--clear', '--max-workers', '2'], {
      cwd: legacy, env: { ...env, PANCAKE_FETCH_PREDECESSOR: '0', VERCEL_ENV: 'development', CI: '1',
        EXPO_PUBLIC_SUPABASE_URL: tls.origin, EXPO_PUBLIC_API_URL: `${tls.origin}/functions/v1/api`, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: keys.ANON_KEY },
    })
    await cp(`${legacy}/dist`, `${root}/web-release${suffix}`, { recursive: true })
    await writeFile(`${root}/web-release${suffix}/l1-release.json`, JSON.stringify({ commit, version }))
  }
} else if (mode === 'serve') {
  const { startEdge, seedScreens } = await import(`${checkout}/scripts/perf-lab/runtime.mjs`)
  const { captureServer } = await import(`${checkout}/scripts/perf-lab/capture.mjs`)
  const edge = await startEdge(`${root}/evidence`)
  let server, stopping = false
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { stopping = true })
  try {
    const fixture = await seedScreens(keys)
    await sql('ALTER SYSTEM SET pg_stat_statements.track=\'all\'; SELECT pg_reload_conf();')
    const scores = JSON.parse(await sql(`SELECT json_agg(r) FROM (SELECT id,home_points,away_points FROM public.matchups WHERE league_id='${fixture.fixture.leagueId}' AND week_number=1 ORDER BY id) r`))
    assert.equal(scores.length, 5)
    await writeFile(`${root}/evidence/score-fixture.json`, JSON.stringify(scores))
    await writeFile(`${root}/active-frontend`, 'broadcast')
    let active
    console.log('Starting L1 integration runtime on 650xx')
    while (!stopping) {
      const next = (await readFile(`${root}/active-frontend`, 'utf8')).trim()
      assert.ok(['broadcast', 'postgres'].includes(next))
      if (next !== active) {
        await server?.close()
        server = await captureServer({ root: `${root}/${next === 'broadcast' ? 'web-export' : 'web-baseline'}`, evidence: `${root}/evidence`, key: tls.key, cert: tls.cert })
        active = next
        await writeFile(`${root}/runtime-ready.json`, JSON.stringify({ origin: tls.origin, active }))
        await writeFile(`${root}/active-frontend-ready`, active)
      }
      await delay(250)
    }
  } finally { await server?.close(); await edge.close(); await rm(`${root}/runtime-ready.json`, { force: true }) }
} else if (mode === 'verify') run(process.execPath, ['tests/db/l1-realtime-verify.mjs', ...process.argv.slice(3)])

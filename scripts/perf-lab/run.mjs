import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { command } from './process.mjs'
import { sourceRoot, json, target, evidenceRoot } from './common.mjs'
import { renderReport } from './report.mjs'
import { randomUUID } from 'node:crypto'
import { selectionEnvironment, workloadSelection } from './selection.mjs'
import { archiveEvidence } from './evidence.mjs'
import { verifyArchivePaths } from './transfer.mjs'
import { inventory } from './workloads.mjs'
import { writeReview } from './review.mjs'
import { detachedReplayCommand, detachedReceipt } from './detached.mjs'

const remoteRoot = `$HOME/${target.relativeRoot}`
export const remotePrefix = `export PATH=${remoteRoot}/bin:$HOME/pancake-local/tools:$PATH; export DOCKER_HOST=unix://$HOME/pancake-t_4ba51e0d/lima/pancake-dev/sock/docker.sock; export PLAYWRIGHT_BROWSERS_PATH=$HOME/pancake-local/browsers; export PERF_LAB_ON_MINI=1 PERF_LAB_ALLOW_LAN=1 PERF_LAB_LANE=${target.lane} PERF_LAB_PROJECT=${target.project} PERF_LAB_PORT_PREFIX=${target.prefix} PERF_LAB_RESTORE=${process.env.PERF_LAB_RESTORE === '0' ? '0' : '1'} PERF_LAB_TLS_SELF_SIGNED=${process.env.PERF_LAB_TLS_SELF_SIGNED === '1' ? '1' : '0'}; `
const ssh = (script, options = {}) => command('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'mini', `${remotePrefix}${script}`], { timeout: 1800000, ...options })

export async function syncSource() {
  const dirty = (await command('git', ['status', '--porcelain'], { cwd: sourceRoot })).stdout
  assert.equal(dirty, '', 'Commit the work before syncing the reproducible lab')
  const temporary = await mkdtemp(path.join(tmpdir(), 'pancake-perf-lab-'))
  try {
    await command('git', ['bundle', 'create', path.join(temporary, 'source.bundle'), 'HEAD'], { cwd: sourceRoot })
    await command('scp', [path.join(temporary, 'source.bundle'), `mini:${target.relativeRoot}/source.bundle`])
    await ssh(`test -z "$(docker ps -aq --filter label=com.supabase.cli.project=${target.project})" || { printf "The private replay stack is active; source sync is refused.\\n" >&2; exit 1; }; mkdir -p "${remoteRoot}"; if [ -d "${remoteRoot}/repo" ]; then cd "${remoteRoot}/repo" && test -z "$(git status --porcelain)" && git fetch -q ../source.bundle HEAD && git checkout -q FETCH_HEAD; else git clone -q "${remoteRoot}/source.bundle" "${remoteRoot}/repo" && cp -c -R "$HOME/pancake-t_4ba51e0d/lanes/root-fable/repo/node_modules" "${remoteRoot}/repo/node_modules"; fi`)
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

export async function isolatedPhases(limit, execute) {
  const screens = await execute('walk', limit, { writeDocs: false })
  const replay = await execute('replay', undefined, { skipSync: true })
  return Math.max(screens ?? 0, replay ?? 0)
}

export async function run(mode = 'all', limit, options = {}) {
  assert.ok(['sync', 'preflight', 'database', 'identity-test', 'capture-test', 'all', 'walk', 'replay', 'replay-detached'].includes(mode), 'Unknown lab mode')
  assert.ok(limit === undefined || Number.isInteger(limit) && limit > 0, 'A walk limit must be a positive integer')
  if (mode === 'all') {
    process.exitCode = await isolatedPhases(limit, run)
    return process.exitCode
  }
  const selected = workloadSelection()
  if (selected.surfaces || selected.cases) {
    const { surfaces, rows } = await inventory()
    assert.ok(!selected.surfaces || selected.surfaces.every(id => surfaces.some(surface => surface.id === id)), 'Unknown requested surface')
    assert.ok(!selected.cases || selected.cases.every(id => rows.some(row => row.id === id)), 'Unknown requested case')
  }
  if (options.skipSync) assert.equal((await command('git', ['status', '--porcelain'], { cwd: sourceRoot })).stdout, '', 'Source changed between isolated workloads')
  else await syncSource()
  const runId = randomUUID()
  const captureProfile = process.env.PERF_LAB_CAPTURE_PROFILE ?? 'full'
  assert.ok(['full', 'control'].includes(captureProfile), 'Unknown capture profile')
  const identityExpected = process.env.PERF_LAB_IDENTITY_EXPECTED
  assert.ok(identityExpected === undefined || ['split', 'linked'].includes(identityExpected), 'Unknown identity expectation')
  const environment = `${selectionEnvironment()}PERF_LAB_CAPTURE_PROFILE=${captureProfile} ${identityExpected ? `PERF_LAB_IDENTITY_EXPECTED=${identityExpected} ` : ''}`
  if (mode === 'sync') return
  if (mode === 'replay-detached') {
    assert.equal(selected.seconds, 0, 'Unset PERF_LAB_SECONDS for a detached replay')
    const backup = path.join(homedir(), 'Documents/pancake-db-backup-2026-10-28')
    await ssh(`mkdir -p "${remoteRoot}/backup" && chmod 700 "${remoteRoot}/backup"`)
    try {
      if (process.env.PERF_LAB_RESTORE !== '0') await command('scp', ['-C', path.join(backup, 'schema.sql'), path.join(backup, 'data.sql'), `mini:${target.relativeRoot}/backup/`], { timeout: 600000 })
      const launch = `cd "${remoteRoot}/repo" && ${detachedReplayCommand(runId, captureProfile)}`
      const result = await ssh(launch)
      const source = (await command('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot })).stdout.trim()
      const receipt = { ...detachedReceipt(runId, result.stdout, source, captureProfile), command: remotePrefix + launch }
      await json(path.join(homedir(), 'Documents/pancake-season-mission/fable/program3/evidence/detached-latest.json'), receipt)
      console.log(JSON.stringify(receipt, null, 2))
      return 0
    } catch (error) {
      await ssh(`rm -rf "${remoteRoot}/backup"`)
      throw error
    }
  }
  if (['database', 'identity-test', 'all', 'walk', 'replay'].includes(mode)) {
    const backup = path.join(homedir(), 'Documents/pancake-db-backup-2026-10-28')
    await ssh(`mkdir -p "${remoteRoot}/backup" && chmod 700 "${remoteRoot}/backup"`)
    try {
      if (process.env.PERF_LAB_RESTORE !== '0') await command('scp', ['-C', path.join(backup, 'schema.sql'), path.join(backup, 'data.sql'), `mini:${target.relativeRoot}/backup/`], { timeout: 600000 })
      const phases = mode === 'all' ? 2 : 1
      const timeout = selected.seconds === 0 ? 0 : Math.max(1800000, (selected.seconds * phases + 600) * 1000)
      const result = await ssh(`cd "${remoteRoot}/repo" && ${environment}PERF_LAB_RUN_ID=${runId} node scripts/perf-lab/mini.mjs ${mode}${limit === undefined ? '' : ` ${limit}`}`, { allowFailure: true, timeout })
      console.log(result.stdout)
      if (result.code !== 0) console.error(result.stderr.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]').slice(-5000))
      const evidence = evidenceRoot
      await mkdir(evidence, { recursive: true })
      await archiveEvidence(evidence)
      const transfer = await mkdtemp(path.join(tmpdir(), 'pancake-evidence-'))
      try {
        const known = (await readdir(path.join(evidence, 'history')).catch(() => [])).filter(id => /^[a-f0-9-]{36}$/.test(id))
        await ssh(`cd "${remoteRoot}/repo" && node scripts/perf-lab/transfer.mjs '${known.join(',')}'`)
        const file = path.join(transfer, 'evidence.tar.gz')
        await command('scp', [`mini:${target.relativeRoot}/evidence-transfer.tar.gz`, file], { timeout: 600000 })
        const paths = await command('tar', ['-tzf', file])
        const details = await command('tar', ['-tvzf', file])
        verifyArchivePaths(paths.stdout, details.stdout)
        await command('tar', ['-xzf', file, '-C', evidence], { timeout: 600000 })
      } finally { await rm(transfer, { recursive: true, force: true }) }

      if (['all', 'walk', 'replay'].includes(mode)) {
        const receipt = JSON.parse(await readFile(path.join(evidence, 'database-run.json'), 'utf8').catch(() => 'null'))
        const current = receipt?.runId === runId
        const receipts = current ? JSON.parse(await readFile(path.join(evidence, 'walk.json'), 'utf8').catch(() => '[]')) : []
        const simulation = current ? JSON.parse(await readFile(path.join(evidence, 'two-day.json'), 'utf8').catch(() => 'null')) : null
        await renderReport({ evidenceRoot: evidence, receipts, simulation, writeDocs: options.writeDocs !== false })
        const screenshots = path.join(evidence, '../first-load')
        await mkdir(screenshots, { recursive: true })
        const manifestFile = path.join(screenshots, 'manifest.json')
        const manifest = new Map(JSON.parse(await readFile(manifestFile, 'utf8').catch(() => '[]')).map(row => [row.id, row]))
        for (const row of receipts.filter(row => row.webkit?.firstFrameReady || row.webkit?.failureScreenshot)) {
          const entry = { id: row.id, source: receipt.source, fingerprint: row.fingerprint, passed: row.webkit.passed, images: {} }
          for (const [stage, key] of [['first', 'firstScreenshot'], ['settled', 'settledScreenshot'], ['failure', 'failureScreenshot']]) {
            const file = row.webkit[key]
            const name = `${row.id.replaceAll('/', '--')}-${stage}.png`
            if (!file) { await rm(path.join(screenshots, name), { force: true }); continue }
            if (path.isAbsolute(file) || file.split('/').includes('..')) continue
            await cp(path.join(evidence, file), path.join(screenshots, name))
            entry.images[stage] = { file: name, sha256: row.webkit.hashes[key] }
          }
          manifest.set(row.id, entry)
        }
        await json(manifestFile, [...manifest.values()])
        await writeReview(screenshots, [...manifest.values()])
      }
      process.exitCode = result.code
      return result.code
    } finally { await ssh(`rm -rf "${remoteRoot}/backup"`) }
  } else {
    const result = await ssh(`cd "${remoteRoot}/repo" && node scripts/perf-lab/mini.mjs ${mode}`, { allowFailure: true })
    console.log(result.stdout)
    process.exitCode = result.code
    return result.code
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'bytes') {
    const runners = {
      build: () => import('../bytes-build.mjs'), browser: () => import('../bytes-browser.mjs'),
      fixture: () => import('../bytes-fixture.mjs'), lab: () => import('../bytes-lab.mjs'), proxy: () => import('../bytes-proxy.mjs'),
    }
    const name = process.argv[3]
    assert.ok(Object.hasOwn(runners, name), 'Unknown byte measurement command')
    process.argv.splice(1, 3, fileURLToPath(new URL(`../bytes-${name}.mjs`, import.meta.url)))
    await runners[name]()
  } else if (process.argv[2] === 'collect') process.exitCode = await (await import('./collect.mjs')).collectDetached(process.argv[3], remotePrefix)
  else await run(process.argv[2], process.argv[3] === undefined ? undefined : Number(process.argv[3]))
}

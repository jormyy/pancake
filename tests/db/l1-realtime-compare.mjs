import assert from 'node:assert/strict'
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { requireMini, project } from '../../scripts/perf-lab/common.mjs'
import { sql } from '../../scripts/perf-lab/database.mjs'
import { command } from '../../scripts/perf-lab/process.mjs'
import { beginConcurrentRun } from './l1-realtime-concurrency.mjs'
import { stackCommand } from './l1-realtime-stack.mjs'

await requireMini()
assert.equal(project, 'pt4bafablel1')
const [label, selected = 'both', repeats = '5', override] = process.argv.slice(2)
assert.match(label ?? '', /^[a-z0-9-]+$/)
assert.ok(['idle', 'live', 'inventory', 'both'].includes(selected))
const rounds = Number(repeats)
assert.ok(Number.isInteger(rounds) && rounds >= 5 && rounds <= 10)
const profiles = selected === 'both' ? ['idle', 'live'] : [selected]
const liveWriteIntervalMs = Number(process.env.L1_WRITE_INTERVAL_MS ?? 20000)
assert.ok([2000, 20000].includes(liveWriteIntervalMs))
const root = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-l1')
const { origin } = JSON.parse(await readFile(path.join(root, 'runtime-ready.json'), 'utf8'))
assert.equal(new URL(origin).port, '62284')
const migration = await readFile('supabase/migrations/20261214004000_live_broadcast.sql', 'utf8')
const tables = [...migration.matchAll(/CREATE TRIGGER broadcast_live_change AFTER INSERT OR UPDATE OR DELETE ON public\.([a-z_]+)/g)].map(([, table]) => table)
assert.equal(tables.length, 16)
const lockFile = path.join(root, 'comparison.lock')
let lock
try { lock = await open(lockFile, 'wx', 0o600) }
catch (error) {
  if (error.code !== 'EEXIST') throw error
  const owner = Number((await readFile(lockFile, 'utf8')).trim())
  assert.ok(Number.isInteger(owner) && owner > 1)
  let stopped = false
  try { process.kill(owner, 0) }
  catch (failure) { if (failure.code === 'ESRCH') stopped = true; else throw failure }
  assert.ok(stopped, `The comparison is already running as PID ${owner}`)
  await rm(lockFile)
  lock = await open(lockFile, 'wx', 0o600)
}
await lock.writeFile(String(process.pid))
let finishRun
const progress = value => writeFile(path.join(root, 'comparison-progress.json'), JSON.stringify({ label, ...value, at: new Date().toISOString() }, null, 2))
const switchFrontend = async mode => {
  await writeFile(path.join(root, 'active-frontend.next'), mode)
  await rename(path.join(root, 'active-frontend.next'), path.join(root, 'active-frontend'))
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await readFile(path.join(root, 'active-frontend-ready'), 'utf8')).trim() === mode) return
    await delay(100)
  }
  throw new Error('Private frontend switch times out')
}
try {
  await progress({ status: 'preparing-concurrent', pid: process.pid })
  finishRun = await beginConcurrentRun()
  const source = (await command('git', ['rev-parse', 'HEAD'])).stdout.trim()
  const build = JSON.parse(await readFile(path.join(root, 'evidence/build-2111.json'), 'utf8'))
  assert.equal(build.baselineCommit, '952580ce3204598d1fd120b3f121d166c7626028')
  assert.match(build.candidateCommit, /^[a-f0-9]{40}$/)
  await command('git', ['diff', '--exit-code', '--name-only', build.candidateCommit, source, '--',
    'app', 'components', 'constants', 'contexts', 'hooks', 'lib', 'types', 'core/src', 'supabase/functions'])
  assert.equal(build.sharedCacheFix, true)
  const manifest = { label, ...build, source, liveWriteIntervalMs, concurrentLanes: true, measurementLock: false }
  const manifestFile = path.join(root, 'evidence', `${label}-source.json`)
  const previousManifest = await readFile(manifestFile, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error })
  if (previousManifest) assert.deepEqual(previousManifest, manifest)
  else await writeFile(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600 })
  if (process.env.L1_REQUIRE_VERIFY === '1') {
    const verification = JSON.parse(await readFile(path.join(root, 'evidence/verify-2111.json'), 'utf8'))
    assert.equal(verification.status, 'pass')
    assert.equal(verification.source, source)
  }
  for (const profile of profiles) {
    const seconds = Number(override ?? (profile === 'idle' ? 120 : profile === 'live' ? 300 : 60))
    const writeIntervalMs = profile === 'live' ? liveWriteIntervalMs : 2000
    assert.ok(Number.isFinite(seconds) && seconds >= 10)
    for (let round = 1; round <= rounds; round++) {
      for (const mode of round % 2 ? ['broadcast', 'postgres'] : ['postgres', 'broadcast']) {
        const name = `${label}-${profile}-${mode}-${round}`
        const reportFile = path.join(root, 'evidence', `${name}.json`)
        const previous = await readFile(reportFile, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error })
        if (previous?.status === 'complete') {
          assert.equal(previous.mode, mode)
          assert.equal(previous.profile, profile)
          assert.equal(previous.seconds, seconds)
          assert.equal(previous.apiErrors, 0)
          assert.equal(previous.missing.length, 0)
          assert.equal(previous.disconnects, 0)
          assert.equal(previous.writeIntervalMs, writeIntervalMs)
          assert.equal(previous.writes, profile === 'idle' ? 0 : Math.ceil(seconds * 1000 / writeIntervalMs))
          if (previous.infrastructureBefore) assert.deepEqual(previous.infrastructureBefore, previous.infrastructureAfter)
          continue
        }
        if (previous) {
          assert.notEqual(previous.status, 'failed', 'A failed capture requires diagnosis and a fresh label')
          const worker = await command('pgrep', ['-f', `^node tests/db/l1-realtime-bench.mjs ${name} `], { allowFailure: true })
          assert.equal(worker.stdout.trim(), '', `The capture ${name} still has a live worker`)
          await rename(reportFile, reportFile.replace('.json', `.failed-${Date.now()}.json`))
        }
        await progress({ profile, round, mode, seconds, status: 'preparing', name })
        await switchFrontend(mode)
        await sql(tables.map(table => `ALTER TABLE public.${table} ${mode === 'broadcast' ? 'ENABLE' : 'DISABLE'} TRIGGER broadcast_live_change;`).join('\n'))
        await stackCommand('docker', ['restart', 'supabase_realtime_pt4bafablel1'], {}, { record: value => progress({ profile, round, mode, status: 'retrying-socket', ...value }) })
        await delay(10000)
        await progress({ profile, round, mode, seconds, status: 'running', name, expectedFinish: new Date(Date.now() + (seconds + 120) * 1000).toISOString() })
        console.log((await command('node', ['tests/db/l1-realtime-bench.mjs', name, mode, profile, String(seconds), origin, String(writeIntervalMs)], { timeout: (seconds + 240) * 1000 })).stdout.trim())
      }
    }
  }
  await progress({ status: 'complete' })
} catch (error) {
  await progress({ status: 'failed', error: error.message })
  throw error
} finally {
  try { if (finishRun) await sql(tables.map(table => `ALTER TABLE public.${table} ENABLE TRIGGER broadcast_live_change;`).join('\n')) }
  finally {
    try { if (finishRun) await switchFrontend('broadcast') }
    finally {
      try { await finishRun?.() }
      finally { await lock.close(); await rm(lockFile) }
    }
  }
}

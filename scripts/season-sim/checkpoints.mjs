import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, cp, mkdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { setClock } from './clock.mjs'
import { functionFingerprint } from './overlay.mjs'
import { config, delay, fixtureDirectory, miniRoot, originUrl, sha256, writeJson } from './common.mjs'
import { databaseEnvironment, localKeys, sql, sqlJson } from './local-stack.mjs'

export const segmentNames = ['automatic-champion', 'live-week', 'pre-deadline', 'pre-playoffs', 'pre-rollover', 'post-rollover', 'pre-draft', 'post-draft', 'next-season-start', 'waiver-week']
export function snapshotRoot() {
  const root=process.env.SEASON_SIM_SNAPSHOT_ROOT ?? path.resolve(miniRoot, '../../shared',process.env.SEASON_SIM_MODE==='two-season'?'sim2':'sim','snapshots')
  const protectedRoot=path.resolve(miniRoot,'../../shared/sim')
  if(process.env.SEASON_SIM_MODE==='two-season')assert.ok(path.resolve(root)!==protectedRoot&&!path.resolve(root).startsWith(protectedRoot+'/'),'The two-season leg cannot write the running replay snapshot folder')
  return root
}

export function validSnapshotName(name){
  return segmentNames.includes(name)||/^season-\d{4}-automatic-champion$/.test(name)||/^(recovery|real-second)-\d{4}-\d{2}-\d{2}$/.test(name)
}

async function snapshotActivity() {
  const [workers, response] = await Promise.all([
    sqlJson("SELECT coalesce(json_agg(r),'[]') FROM (SELECT id,function_name,worker_status,queued_at FROM edge_invocations WHERE worker_status IN ('pending','running') ORDER BY id) r", 'Snapshot workers'),
    fetch(`${originUrl('edge')}/health`, { redirect: 'error', signal: AbortSignal.timeout(5000) }).catch(error => {
      if (error.cause?.code !== 'ECONNREFUSED') throw error
      return null
    }),
  ])
  if (response == null) {
    assert.equal(workers.length, 0, `Stopped runtime has unfinished snapshot workers: ${JSON.stringify(workers)}`)
    return { workers, runtime: { active: 0, fetches: 0 } }
  }
  assert.ok(response.ok, 'Snapshot runtime health read must succeed')
  return { workers, runtime: await response.json() }
}

export async function waitForSnapshotWorkers({ read = snapshotActivity, wait = delay, now = Date.now, timeoutMs = 120000, advance = null } = {}) {
  const started = now()
  let polls = 0, firstAt = null, advancedMs = 0
  for (;;) {
    const activity = await read()
    polls++
    if (!activity.workers.length && activity.runtime.active === 0 && activity.runtime.fetches === 0) return { polls, waitedMs: now() - started, advancedMs }
    assert.ok(now() - started < timeoutMs, `Snapshot workers did not settle under the paused clock: ${JSON.stringify(activity)}`)
    if (advance && activity.runtime.active > 0 && activity.runtime.sleeping === activity.runtime.active && activity.runtime.fetches === 0 && activity.runtime.nextAt != null) {
      const at = Date.parse(activity.runtime.at)
      firstAt ??= at
      assert.ok(Number.isFinite(at) && Number.isFinite(activity.runtime.nextAt) && activity.runtime.nextAt - firstAt <= timeoutMs, 'Snapshot worker deadlines must settle within two business minutes')
      if (activity.runtime.nextAt > at) {
        await advance(activity.runtime.nextAt)
        advancedMs = activity.runtime.nextAt - firstAt
        continue
      }
    }
    await wait(10)
  }
}

async function snapshotDirectory(name) {
  assert.ok(validSnapshotName(name), 'Unknown snapshot segment')
  const root = snapshotRoot()
  assert.ok(path.isAbsolute(root) && !root.startsWith(`${process.cwd()}/`), 'Snapshots must stay outside the repository')
  await mkdir(root, { recursive: true, mode: 0o700 })
  assert.equal(await realpath(root), path.resolve(root), 'Snapshot root cannot contain symlinks')
  return path.join(root, name)
}

export async function saveSnapshot(name, cursor) {
  const directory = await snapshotDirectory(name)
  await mkdir(directory, { mode: 0o700 })
  const clock = JSON.parse(await readFile(path.join(miniRoot, 'state/clock.json'), 'utf8'))
  assert.equal(clock.rate, 0, 'Snapshots require a paused business clock')
  const quiescence = await waitForSnapshotWorkers()
  const env = databaseEnvironment()
  const file = path.join(directory, 'database.dump')
  execFileSync('pg_dump', ['--format=custom', '--data-only', '--schema=public', '--schema=private', '--schema=auth', '--schema=season_sim', '--no-owner', '--no-privileges', '--file', file], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  await chmod(file, 0o600)
  await cp(path.join(miniRoot, 'evidence/upstream-summary.json'), path.join(directory, 'upstream-summary.json'))
  await cp(path.join(miniRoot, 'state'), path.join(directory, 'state'), { recursive: true })
  const tables = await sqlJson("SELECT coalesce(json_agg(format('%I.%I',schemaname,tablename)),'[]') FROM pg_tables WHERE schemaname IN ('public','private','auth','season_sim')", 'Snapshot tables')
  const metadata = { name, createdAt: new Date().toISOString(), project: config.project, clock, cursor, tables, quiescence, dumpSha256: sha256(await readFile(file)), fixtures: { directory: fixtureDirectory, manifestSha256: sha256(await readFile(path.join(fixtureDirectory, 'manifest.jsonl'))),planSha256:process.env.SEASON_SIM_MODE==='two-season'?sha256(await readFile(path.join(fixtureDirectory,'two-season-plan.json'))):null }, measuredSeconds: null }
  await writeJson(path.join(directory, 'snapshot.json'), metadata)
  await chmod(path.join(directory, 'snapshot.json'), 0o600)
  return { name, createdAt: metadata.createdAt, dumpSha256: metadata.dumpSha256, quiescence }
}

export async function restoreSnapshot(name) {
  const directory = await snapshotDirectory(name)
  const metadata = JSON.parse(await readFile(path.join(directory, 'snapshot.json'), 'utf8'))
  assert.equal(metadata.name, name)
  assert.equal(sha256(await readFile(path.join(directory, 'database.dump'))), metadata.dumpSha256, 'Snapshot dump checksum')
  assert.equal(sha256(await readFile(path.join(fixtureDirectory, 'manifest.jsonl'))), metadata.fixtures.manifestSha256, 'Segment must use the pinned fixture manifest')
  if(metadata.fixtures.planSha256)assert.equal(sha256(await readFile(path.join(fixtureDirectory,'two-season-plan.json'))),metadata.fixtures.planSha256,'Segment must use the pinned calendar and publication policies')
  const keys = localKeys()
  process.env.SUPABASE_DB_URL = keys.DB_URL
  process.env.SUPABASE_URL = keys.API_URL
  const env = databaseEnvironment()
  assert.equal(await sql("SELECT current_setting('cron.launch_active_jobs')"), 'off')
  assert.equal(await sql('SELECT count(*) FROM cron.job'), '0')
  await setClock({ install: true, at: new Date(metadata.clock.sim_ms ?? metadata.clock.simMs).toISOString(), rate: 0 })
  const definitionsBefore = await functionFingerprint()
  for (const table of metadata.tables) assert.match(table, /^(public|private|auth|season_sim)\.[a-z_][a-z0-9_]*$/, 'Snapshot table must be in a permitted schema')
  await sql(`TRUNCATE ${metadata.tables.join(',')} RESTART IDENTITY CASCADE`)
  execFileSync('pg_restore', ['--dbname', 'postgres', '--data-only', '--disable-triggers', '--no-owner', '--no-privileges', '--exit-on-error', path.join(directory, 'database.dump')], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  const definitionsAfter = await functionFingerprint()
  assert.equal(definitionsAfter, definitionsBefore, 'Restoring data must preserve the lane application function definitions')
  await mkdir(path.join(miniRoot, 'evidence'), { recursive: true })
  await cp(path.join(directory, 'upstream-summary.json'), path.join(miniRoot, 'evidence/upstream-summary.json'))
  await cp(path.join(directory, 'state'), path.join(miniRoot, 'state'), { recursive: true })
  metadata.restore = { definitionsBefore, definitionsAfter, functionsPreserved: true, restoredAt: new Date().toISOString(), dataOnly: true }
  await writeJson(path.join(miniRoot, 'evidence/restore-proof.json'), metadata.restore)
  return metadata
}

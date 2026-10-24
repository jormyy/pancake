#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { readFile, mkdir, realpath, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import { config, fixtureDirectory, miniRoot, season, sha256, writeJson } from './common.mjs'
import { sourceEvidence } from './source-manifest.mjs'
import { clearOwnBackup, localKeys, setupStack, sql } from './local-stack.mjs'
import { replay } from './replay.mjs'
import { launcherCheck } from './launcher-check.mjs'

const { values } = parseArgs({ options: { 'source-sha': { type: 'string' }, 'check-first-date': { type: 'boolean' }, 'check-through': { type: 'string' } } })
const check = launcherCheck(values)
const real = process.env.SEASON_SIM_MODE === 'two-season'
if (real) { assert.equal(season.year,2025); assert.ok(!path.resolve(fixtureDirectory).startsWith(path.resolve(miniRoot,'../../shared/sim') + '/'),'The new leg cannot read or write the running replay input folder') }
assert.match(values['source-sha'] ?? '', /^[a-f0-9]{40}$/, 'A committed integration SHA is required')
assert.equal(await realpath(process.cwd()), path.join(miniRoot, 'repo'))
const source = await sourceEvidence()
assert.equal(source.application?.commit, values['source-sha'])
if (!check) assert.equal(source.committedHarness, true, 'Fresh replay refuses a harness overlay')
assert.equal(sha256(await readFile(path.join(miniRoot, 'integration.tar'))), source.application.archiveSha256)
const runId = new Date().toISOString().replaceAll(':', '-')
const evidence = path.join(miniRoot, 'evidence')
try { await rename(evidence, path.join(miniRoot, `evidence-before-${runId}`)) } catch (error) { if (error.code !== 'ENOENT') throw error }
await mkdir(evidence)
process.env.SEASON_SIM_SNAPSHOT_ROOT = path.join(config.snapshots, runId)
await writeJson(path.join(evidence, 'launch.json'), { source, runId, pid: process.pid, command: process.argv, startedAt: new Date().toISOString(), snapshots: process.env.SEASON_SIM_SNAPSHOT_ROOT, mode: check?.scope ?? (real ? 'Fresh real two-season replay' : 'Fresh full replay'), inputDirectory: fixtureDirectory, check })
let exit = 1, ready = false
try {
  if (real) execFileSync(process.execPath, ['scripts/season-sim/plan-audit.mjs'], { env: process.env, stdio: 'inherit' })
  execFileSync(config.cli, ['stop', '--project-id', config.project, '--no-backup'], { stdio: ['ignore', 'ignore', 'inherit'] })
  const backupRemoved = await clearOwnBackup()
  await writeJson(path.join(evidence, 'fresh-reset.json'), { project: config.project, backupRemoved })
  await setupStack()
  ready = true
  await replay(check ? { days: check.days } : {})
  execFileSync(process.execPath, ['scripts/season-sim/report.mjs'], { env: process.env, stdio: 'inherit' })
  const result = JSON.parse(await readFile(path.join(evidence, 'final-run.json'), 'utf8'))
  if (check) {
    assert.equal(result.fullAcceptance, false)
    assert.equal(result.complete, true)
    assert.equal(result.completedDates, check.days)
    assert.equal(result.requestedDates, check.days)
    assert.equal(result.freshDatabase, true)
    assert.ok(result.liveSamples > 0)
    const checkpoint = JSON.parse(await readFile(path.join(evidence, 'replay-checkpoint.json'), 'utf8'))
    assert.deepEqual(checkpoint.days.map(row => row.date), check.dates)
    assert.deepEqual(checkpoint.snapshots.map(row => row.name), check.snapshots)
    for (const snapshot of checkpoint.snapshots) {
      const directory = path.join(process.env.SEASON_SIM_SNAPSHOT_ROOT, snapshot.name)
      assert.ok((await stat(path.join(directory, 'database.dump'))).size > 0)
      assert.ok((await stat(path.join(directory, 'snapshot.json'))).size > 0)
    }
    const proof = { passed: true, scope: check.scope, through: check.through, dates: check.dates, games: checkpoint.days.reduce((sum, day) => sum + day.finals.games, 0), liveSamples: result.liveSamples, snapshots: checkpoint.snapshots, snapshotRoot: process.env.SEASON_SIM_SNAPSHOT_ROOT }
    await writeJson(path.join(evidence, 'launcher-check.json'), proof)
    if (values['check-first-date']) await writeJson(path.join(evidence, 'first-date-check.json'), { ...proof, date: checkpoint.days[0].date })
  } else assert.equal(result.fullAcceptance, true, 'Fresh replay requires all measured acceptance areas')
  assert.equal(result.invariantFailures, 0)
  exit = 0
} catch (error) {
  await writeJson(path.join(evidence, 'launch-failure.json'), { name: error.name, message: error.message, stack: error.stack })
  console.error(error)
  if (ready) {
    try { execFileSync(process.execPath, ['scripts/season-sim/report.mjs'], { env: process.env, stdio: 'inherit' }) } catch {}
  }
} finally {
  const cleanup = { clockRestored: false, stackStopped: false, clockError: null, stackError: null, backupRemoved: null, backupError: null }
  if (ready) {
    try {
      process.env.SUPABASE_DB_URL = localKeys().DB_URL
      const restore = await readFile('scripts/season-sim/restore-clock.sql', 'utf8')
      await sql(restore.slice(restore.indexOf('BEGIN;')))
      cleanup.clockRestored = true
    } catch (error) { cleanup.clockError = error.message; exit = 1 }
  }
  try {
    execFileSync(config.cli, ['stop', '--project-id', config.project], { stdio: ['ignore', 'ignore', 'inherit'] })
    cleanup.stackStopped = true
  } catch (error) { cleanup.stackError = error.message; exit = 1 }
  if (check && cleanup.stackStopped) {
    try { cleanup.backupRemoved = await clearOwnBackup() }
    catch (error) { cleanup.backupError = error.message; exit = 1 }
  }
  await writeJson(path.join(evidence, 'exit.json'), { exit, finishedAt: new Date().toISOString(), cleanup })
  process.exitCode = exit
}

#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { readFile, mkdir, realpath, rename } from 'node:fs/promises'
import path from 'node:path'
import { config, miniRoot, sha256, writeJson } from './common.mjs'
import { sourceEvidence } from './source-manifest.mjs'
import { clearOwnBackup, localKeys, setupStack, sql } from './local-stack.mjs'
import { replay } from './replay.mjs'

const { values } = parseArgs({ options: { 'source-sha': { type: 'string' } } })
assert.match(values['source-sha'] ?? '', /^[a-f0-9]{40}$/, 'A committed integration SHA is required')
assert.equal(await realpath(process.cwd()), path.join(miniRoot, 'repo'))
const source = await sourceEvidence()
assert.equal(source.application?.commit, values['source-sha'])
assert.equal(source.committedHarness, true, 'Fresh replay refuses a harness overlay')
assert.equal(sha256(await readFile(path.join(miniRoot, 'integration.tar'))), source.application.archiveSha256)
const runId = new Date().toISOString().replaceAll(':', '-')
const evidence = path.join(miniRoot, 'evidence')
try { await rename(evidence, path.join(miniRoot, `evidence-before-${runId}`)) } catch (error) { if (error.code !== 'ENOENT') throw error }
await mkdir(evidence)
process.env.SEASON_SIM_SNAPSHOT_ROOT = path.resolve(miniRoot, '../../shared/sim', `snapshots-${runId}`)
await writeJson(path.join(evidence, 'launch.json'), { source, runId, pid: process.pid, command: process.argv, startedAt: new Date().toISOString(), snapshots: process.env.SEASON_SIM_SNAPSHOT_ROOT })
let exit = 1, ready = false
try {
  execFileSync(config.cli, ['stop', '--project-id', config.project, '--no-backup'], { stdio: ['ignore', 'ignore', 'inherit'] })
  const backupRemoved = await clearOwnBackup()
  await writeJson(path.join(evidence, 'fresh-reset.json'), { project: config.project, backupRemoved })
  await setupStack()
  ready = true
  await replay()
  execFileSync(process.execPath, ['scripts/season-sim/report.mjs'], { env: process.env, stdio: 'inherit' })
  const result = JSON.parse(await readFile(path.join(evidence, 'final-run.json'), 'utf8'))
  assert.equal(result.fullAcceptance, true, 'Fresh replay requires all measured acceptance areas')
  assert.equal(result.invariantFailures, 0)
  exit = 0
} catch (error) {
  await writeJson(path.join(evidence, 'launch-failure.json'), { name: error.name, message: error.message, stack: error.stack })
  console.error(error)
  if (ready) {
    try { execFileSync(process.execPath, ['scripts/season-sim/report.mjs'], { env: process.env, stdio: 'inherit' }) } catch {}
  }
} finally {
  const cleanup = { clockRestored: false, stackStopped: false, clockError: null, stackError: null }
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
  await writeJson(path.join(evidence, 'exit.json'), { exit, finishedAt: new Date().toISOString(), cleanup })
  process.exitCode = exit
}

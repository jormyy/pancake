import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, cp, mkdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { setClock } from './clock.mjs'
import { config, miniRoot, sha256, writeJson } from './common.mjs'
import { databaseEnvironment, localKeys, sql, sqlJson } from './local-stack.mjs'

export const segmentNames = ['live-week', 'pre-deadline', 'pre-playoffs', 'pre-rollover', 'pre-draft', 'next-season-start']
export const snapshotRoot = process.env.SEASON_SIM_SNAPSHOT_ROOT ?? path.resolve(miniRoot, '../../shared/sim/snapshots')

async function snapshotDirectory(name) {
  assert.ok(segmentNames.includes(name), 'Unknown snapshot segment')
  assert.ok(path.isAbsolute(snapshotRoot) && !snapshotRoot.startsWith(`${process.cwd()}/`), 'Snapshots must stay outside the repository')
  await mkdir(snapshotRoot, { recursive: true, mode: 0o700 })
  assert.equal(await realpath(snapshotRoot), path.resolve(snapshotRoot), 'Snapshot root cannot contain symlinks')
  return path.join(snapshotRoot, name)
}

export async function saveSnapshot(name, cursor) {
  const directory = await snapshotDirectory(name)
  await mkdir(directory, { mode: 0o700 })
  const clock = JSON.parse(await readFile(path.join(miniRoot, 'state/clock.json'), 'utf8'))
  assert.equal(clock.rate, 0, 'Snapshots require a paused business clock')
  assert.equal(Number(await sql("SELECT count(*) FROM edge_invocations WHERE worker_status IN ('pending','running')")), 0, 'Snapshot cannot include unfinished dispatch')
  const env = databaseEnvironment()
  const file = path.join(directory, 'database.dump')
  execFileSync('pg_dump', ['--format=custom', '--data-only', '--schema=public', '--schema=private', '--schema=auth', '--schema=season_sim', '--no-owner', '--no-privileges', '--file', file], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  await chmod(file, 0o600)
  await cp(path.join(miniRoot, 'evidence/upstream-summary.json'), path.join(directory, 'upstream-summary.json'))
  await cp(path.join(miniRoot, 'state'), path.join(directory, 'state'), { recursive: true })
  const tables = await sqlJson("SELECT coalesce(json_agg(format('%I.%I',schemaname,tablename)),'[]') FROM pg_tables WHERE schemaname IN ('public','private','auth','season_sim')", 'Snapshot tables')
  const metadata = { name, createdAt: new Date().toISOString(), project: config.project, clock, cursor, tables, dumpSha256: sha256(await readFile(file)), fixtures: { directory: path.join(miniRoot, 'fixtures'), manifestSha256: sha256(await readFile(path.join(miniRoot, 'fixtures/manifest.jsonl'))) }, measuredSeconds: null }
  await writeJson(path.join(directory, 'snapshot.json'), metadata)
  await chmod(path.join(directory, 'snapshot.json'), 0o600)
  return { name, createdAt: metadata.createdAt, dumpSha256: metadata.dumpSha256 }
}

export async function restoreSnapshot(name) {
  const directory = await snapshotDirectory(name)
  const metadata = JSON.parse(await readFile(path.join(directory, 'snapshot.json'), 'utf8'))
  assert.equal(metadata.name, name)
  assert.equal(sha256(await readFile(path.join(directory, 'database.dump'))), metadata.dumpSha256, 'Snapshot dump checksum')
  assert.equal(sha256(await readFile(path.join(miniRoot, 'fixtures/manifest.jsonl'))), metadata.fixtures.manifestSha256, 'Segment must use the pinned fixture manifest')
  const keys = localKeys()
  process.env.SUPABASE_DB_URL = keys.DB_URL
  process.env.SUPABASE_URL = keys.API_URL
  const env = databaseEnvironment()
  assert.equal(await sql("SELECT current_setting('cron.launch_active_jobs')"), 'off')
  assert.equal(await sql('SELECT count(*) FROM cron.job'), '0')
  await setClock({ install: true, at: new Date(metadata.clock.sim_ms ?? metadata.clock.simMs).toISOString(), rate: 0 })
  for (const table of metadata.tables) assert.match(table, /^(public|private|auth|season_sim)\.[a-z_][a-z0-9_]*$/, 'Snapshot table must be in a permitted schema')
  await sql(`TRUNCATE ${metadata.tables.join(',')} RESTART IDENTITY CASCADE`)
  execFileSync('pg_restore', ['--dbname', 'postgres', '--data-only', '--disable-triggers', '--no-owner', '--no-privileges', '--exit-on-error', path.join(directory, 'database.dump')], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  await mkdir(path.join(miniRoot, 'evidence'), { recursive: true })
  await cp(path.join(directory, 'upstream-summary.json'), path.join(miniRoot, 'evidence/upstream-summary.json'))
  await cp(path.join(directory, 'state'), path.join(miniRoot, 'state'), { recursive: true })
  return metadata
}

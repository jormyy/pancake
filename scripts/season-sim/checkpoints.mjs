import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
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

export function partitionSchemaForRestore(source,table){
  const attachments=[...source.matchAll(/^ALTER TABLE ONLY [^\n]+ ATTACH PARTITION [^\n]+;$/gm)]
  assert.equal(attachments.length,1,'Partition schema must contain one table attachment')
  assert.ok(attachments[0][0].includes(` ATTACH PARTITION ${table} `),'Partition schema must attach the saved table')
  return `${source.replace(attachments[0][0],'').replace(/^ALTER INDEX [^\n]+ ATTACH PARTITION [^\n]+;\n?/gm,'')}\n${attachments[0][0]}\n`
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
  execFileSync('pg_dump', ['--format=custom', '--data-only', '--schema=public', '--schema=private', '--schema=auth', '--schema=analytics', '--schema=season_sim', '--no-owner', '--no-privileges', '--file', file], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  await chmod(file, 0o600)
  await cp(path.join(miniRoot, 'evidence/upstream-summary.json'), path.join(directory, 'upstream-summary.json'))
  await cp(path.join(miniRoot, 'state'), path.join(directory, 'state'), { recursive: true })
  const tables = await sqlJson("SELECT coalesce(json_agg(format('%I.%I',schemaname,tablename)),'[]') FROM pg_tables WHERE schemaname IN ('public','private','auth','analytics','season_sim')", 'Snapshot tables')
  const partitionTables=await sqlJson("SELECT coalesce(json_agg(format('%I.%I',namespace.nspname,relation.relname) ORDER BY relation.oid),'[]') FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace WHERE relation.relispartition AND relation.relkind IN ('r','p') AND namespace.nspname IN ('public','private','auth','analytics','season_sim')",'Snapshot partitions')
  const partitions=[]
  for(const [index,table] of partitionTables.entries()){
    assert.match(table,/^(public|private|auth|analytics|season_sim)\.[a-z_][a-z0-9_]*$/,'Partition table must be in a permitted schema')
    const filename=`partition-${index}.sql`
    const partitionFile=path.join(directory,filename)
    execFileSync('pg_dump',['--schema-only','--no-comments','--table',table,'--file',partitionFile],{env,stdio:['ignore','ignore','pipe']})
    await writeFile(partitionFile,partitionSchemaForRestore(await readFile(partitionFile,'utf8'),table))
    await chmod(partitionFile,0o600)
    partitions.push({table,filename,sha256:sha256(await readFile(partitionFile))})
  }
  const metadata = { name, createdAt: new Date().toISOString(), project: config.project, clock, cursor, tables, partitions, quiescence, dumpSha256: sha256(await readFile(file)), fixtures: { directory: fixtureDirectory, manifestSha256: sha256(await readFile(path.join(fixtureDirectory, 'manifest.jsonl'))),planSha256:process.env.SEASON_SIM_MODE==='two-season'?sha256(await readFile(path.join(fixtureDirectory,'two-season-plan.json'))):null }, measuredSeconds: null }
  await writeJson(path.join(directory, 'snapshot.json'), metadata)
  await chmod(path.join(directory, 'snapshot.json'), 0o600)
  return { name, createdAt: metadata.createdAt, dumpSha256: metadata.dumpSha256, quiescence }
}

async function snapshotPartitionFile(partition,directory){
  assert.match(partition.table,/^(public|private|auth|analytics|season_sim)\.[a-z_][a-z0-9_]*$/,'Partition table must be in a permitted schema')
  assert.match(partition.filename,/^partition-\d+\.sql$/,'Partition schema file must stay inside its checkpoint')
  const file=path.join(directory,partition.filename)
  assert.equal(sha256(await readFile(file)),partition.sha256,'Partition schema checksum')
  return file
}

export async function restoreSnapshotPartitions(partitions,directory,env,execute=sql,restore=(command,args,options)=>{execFileSync(command,args,options)}){
  for(const partition of partitions){
    const file=await snapshotPartitionFile(partition,directory)
    if(await execute(`SELECT to_regclass('${partition.table}') IS NOT NULL`)==='t')continue
    restore('psql',['-X','--set','ON_ERROR_STOP=1','--file',file],{env,stdio:['ignore','ignore','pipe']})
    assert.equal(await execute(`SELECT to_regclass('${partition.table}') IS NOT NULL`),'t','Partition schema restore must recreate the saved table')
  }
}

export async function restoreSnapshot(name) {
  const directory = await snapshotDirectory(name)
  const metadata = JSON.parse(await readFile(path.join(directory, 'snapshot.json'), 'utf8'))
  assert.equal(metadata.name, name)
  assert.ok(metadata.tables.includes('analytics.player_season_totals'), 'Checkpoint predates complete analytics capture; create a new snapshot')
  assert.equal(sha256(await readFile(path.join(directory, 'database.dump'))), metadata.dumpSha256, 'Snapshot dump checksum')
  assert.ok(Array.isArray(metadata.partitions),'Checkpoint predates partition schema capture; create a new checkpoint')
  for(const partition of metadata.partitions)await snapshotPartitionFile(partition,directory)
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
  for (const table of metadata.tables) assert.match(table, /^(public|private|auth|analytics|season_sim)\.[a-z_][a-z0-9_]*$/, 'Snapshot table must be in a permitted schema')
  const partitionTables=new Set(metadata.partitions.map(partition=>partition.table))
  const rootTables=metadata.tables.filter(table=>!partitionTables.has(table))
  assert.ok(rootTables.length>0,'Checkpoint must contain root tables')
  await sql(`BEGIN; SET LOCAL session_replication_role='replica'; TRUNCATE ${rootTables.join(',')} RESTART IDENTITY CASCADE; COMMIT`)
  await restoreSnapshotPartitions(metadata.partitions,directory,env)
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

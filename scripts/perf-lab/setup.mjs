import assert from 'node:assert/strict'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { labRoot, ports, project, sourceRoot, digest, json, requireMini, target } from './common.mjs'
import { command } from './process.mjs'
import { captureSettingsSql, localKeys, networkFenceSql, restoreBackup, sql, statementSnapshot } from './database.mjs'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { startPostgresLog } from './postgres-log.mjs'
import { archiveEvidence } from './evidence.mjs'
import { captureLimitMarkers, resetCaptureLimits } from './bounded-log.mjs'
import { diskUsage } from './disk.mjs'

export function privateConfig(text, origin) {
  const configured = text.replace(/^project_id = .*$/m, `project_id = "${project}"`)
    .replace(/\b543(\d\d)\b/g, `${target.prefix}$1`).replace('inspector_port = 8083', `inspector_port = ${ports.inspector}`)
    .replace(/(\[db.migrations\][\s\S]*?enabled = )(?:true|false)/, '$1false')
    .replace(/(\[db.seed\][\s\S]*?enabled = )(?:true|false)/, '$1false')
  return origin ? configured.replace(/(\[auth\]\s*enabled = true)/, `$1\njwt_issuer = "${origin}/auth/v1"`).replace(/^site_url = .*$/m, `site_url = "${origin}"`) : configured
}

export async function withDatabase(action, { restore = true } = {}) {
  await requireMini()
  const configFile = path.join(sourceRoot, 'supabase/config.toml')
  const original = (await command('git', ['show', 'HEAD:supabase/config.toml'])).stdout
  const current = await readFile(configFile, 'utf8')
  assert.ok(current === original || current.includes(`project_id = "${project}"`), 'Refuse an unrelated Supabase configuration')
  const hostname = (await command('scutil', ['--get', 'LocalHostName'])).stdout.trim().toLowerCase()
  assert.match(hostname, /^[a-zA-Z0-9-]+$/)
  const origin = `https://${hostname}.local:${ports.https}`
  const evidence = path.join(labRoot, 'evidence')
  await mkdir(evidence, { recursive: true, mode: 0o700 })
  await archiveEvidence(evidence)
  resetCaptureLimits()
  captureLimitMarkers([evidence, path.join(labRoot, 'state')], true)
  let networkCreated = false, stackAttempted = false, postgresLog
  const receipt = { runId: process.env.PERF_LAB_RUN_ID ?? randomUUID(), startedAt: new Date().toISOString(), restored: false, cleanup: false }
  for (const name of ['access.jsonl', 'realtime.jsonl', 'edge-requests.jsonl', 'edge.log', 'edge-invocations.jsonl', 'dispatch.jsonl', 'postgres-statements.log', 'simulation-exit.json', 'replay-progress.json', 'replay-checkpoint.json', 'replay-edge-access.jsonl', 'replay-client-access.jsonl']) await rm(path.join(evidence, name), { force: true })
  receipt.stage = 'starting'
  await json(path.join(evidence, 'database-run.json'), receipt)
  await json(path.join(evidence, 'walk.json'), [])
  await json(path.join(evidence, 'two-day.json'), { runId: receipt.runId, passed: false, reason: 'not run' })
  try {
    const existing = await command('docker', ['ps', '-aq', '--filter', `label=com.supabase.cli.project=${project}`])
    assert.equal(existing.stdout.trim(), '', 'The private stack already exists; refuse to replace it')
    await writeFile(configFile, privateConfig(original, origin))
    await command('docker', ['network', 'create', project])
    networkCreated = true
    stackAttempted = true
    console.log('Starting the isolated database.')
    await command('supabase', ['start', '--network-id', project, '-x', 'studio,imgproxy,vector,logflare,supavisor,edge-runtime,postgres-meta,mailpit'], { timeout: 240000 })
    if (target.lane === 'fable-l3e') await command('docker', ['update', '--memory=1g', '--memory-swap=1g', `supabase_db_${project}`])
    receipt.diskBeforeRestore = await diskUsage()
    await sql("ALTER SYSTEM SET log_min_duration_statement = '-1';")
    await sql("ALTER SYSTEM SET auto_explain.log_min_duration = '-1';")
    await sql("ALTER SYSTEM SET log_statement = 'none';")
    await sql("ALTER SYSTEM SET cron.launch_active_jobs = 'off';")
    await sql('SELECT pg_reload_conf();')
    await sql(networkFenceSql)
    if (restore) {
      const attestation = JSON.parse(await readFile(path.join(sourceRoot, 'tests/e2e/db-security-catalog-attestations.json'), 'utf8')).preMigration
      const migrations = (await readdir(path.join(sourceRoot, 'supabase/migrations'))).filter(file => /^\d{14}_[a-z0-9_]+\.sql$/.test(file) && file.slice(0, 14) <= attestation.version).sort()
      assert.equal(migrations.length, attestation.count, 'The backup schema baseline differs from the recorded production phase')
      receipt.stage = 'schema-baseline'
      await json(path.join(evidence, 'database-run.json'), receipt)
      console.log('Preparing the recorded backup schema baseline.')
      const baseline = path.join(labRoot, 'schema-baseline')
      await rm(baseline, { recursive: true, force: true })
      await mkdir(path.join(baseline, 'supabase/migrations'), { recursive: true })
      try {
        await writeFile(path.join(baseline, 'supabase/config.toml'), privateConfig(original, origin).replace(/(\[db.migrations\][\s\S]*?enabled = )false/, '$1true'))
        for (const file of migrations) await cp(path.join(sourceRoot, 'supabase/migrations', file), path.join(baseline, 'supabase/migrations', file))
        await command('supabase', ['migration', 'up', '--local', '--include-all', '--workdir', baseline], { timeout: 240000 })
      } finally { await rm(baseline, { recursive: true, force: true }) }
      receipt.schemaBaseline = { ...attestation, source: 'tests/e2e/db-security-catalog-attestations.json' }
      console.log('Restoring the backup at its recorded schema baseline.')
      receipt.backup = await restoreBackup(path.join(labRoot, 'backup'))
      receipt.restored = true
      receipt.backup.sha256 = Object.fromEntries(await Promise.all(['schema.sql', 'data.sql'].map(async file => [file, digest(await readFile(path.join(labRoot, 'backup', file)))])))
      await rm(path.join(labRoot, 'backup'), { recursive: true, force: true })
      await rm(path.join(labRoot, 'seed'), { recursive: true, force: true })
    }
    const next = privateConfig(original, origin).replace(/(\[db.migrations\][\s\S]*?enabled = )false/, '$1true')
    await writeFile(configFile, next)
    receipt.stage = 'migrating'
    await json(path.join(evidence, 'database-run.json'), receipt)
    console.log('Applying the committed migrations.')
    await command('supabase', ['migration', 'up', '--local', '--include-all'], { timeout: 240000 })
    await sql(networkFenceSql)
    await json(path.join(labRoot, 'cron-jobs.json'), JSON.parse(await sql("SELECT coalesce(json_agg(r ORDER BY jobname),'[]') FROM (SELECT jobname,schedule,command FROM cron.job) r")))
    await sql('SELECT cron.unschedule(jobid) FROM cron.job;')
    receipt.source = (await command('git', ['rev-parse', 'HEAD'])).stdout.trim()
    receipt.captureStartedAt = new Date().toISOString()
    postgresLog = startPostgresLog(path.join(evidence, 'postgres-statements.log.gz'), receipt.captureStartedAt, undefined, {
      onLimit: () => sql("ALTER SYSTEM SET auto_explain.log_min_duration='-1'; ALTER SYSTEM SET log_min_duration_statement='-1'; SELECT pg_reload_conf();"),
    })
    receipt.postgresLogPid = postgresLog.pid
    await sql(captureSettingsSql)
    receipt.captureProfile = process.env.PERF_LAB_CAPTURE_PROFILE ?? 'full'
    receipt.capturePolicy = { version: 'bounded-v1', statementStatistics: 'all', statementLogging: 'off', planMinimumMs: receipt.captureProfile === 'control' ? null : 25, planSampleRate: receipt.captureProfile === 'control' ? 0 : 0.01, sqlMaximumBytes: 64 * 1024 * 1024, fileMaximumBytes: 1024 * 1024 * 1024, consoleMaximumBytes: 64 * 1024 * 1024 }
    if (receipt.captureProfile === 'control') await sql("ALTER SYSTEM SET auto_explain.log_min_duration='-1'; ALTER SYSTEM SET log_min_duration_statement='-1'; SELECT pg_reload_conf();")
    assert.equal(await sql("SELECT reset_val FROM pg_settings WHERE name='pg_stat_statements.track';"), 'all')
    let fenceFailed = false
    try { await sql("BEGIN; SELECT net.http_post('https://example.invalid','{}'::jsonb); ROLLBACK;") }
    catch (error) { receipt.networkFenceFailure = error.message; fenceFailed = error.message.includes('Lab blocks external HTTP') }
    assert.ok(fenceFailed, `The database network fence did not reject an external request: ${receipt.networkFenceFailure ?? 'request accepted'}`)
    receipt.networkFence = true
    await command('docker', ['restart', `supabase_rest_${project}`, `supabase_auth_${project}`, `supabase_realtime_${project}`, `supabase_storage_${project}`], { timeout: 60000 })
    const keys = await localKeys()
    let healthy = false
    for (let attempt = 0; attempt < 60; attempt++) {
      healthy = await fetch(`${keys.API_URL}/auth/v1/health`, { headers: { apikey: keys.ANON_KEY } }).then(response => response.ok).catch(() => false)
      if (healthy) break
      await delay(500)
    }
    assert.ok(healthy, 'The local auth service did not restart for SQL capture')
    const survey = JSON.parse(await sql(`SELECT coalesce(json_agg(r), '[]') FROM (
      SELECT schemaname, relname, n_live_tup, pg_total_relation_size(relid) AS bytes
      FROM pg_stat_user_tables WHERE schemaname IN ('public','private','analytics') ORDER BY schemaname,relname
    ) r;`))
    await json(path.join(evidence, 'database-survey.json'), survey)
    await json(path.join(evidence, 'statements-before.json'), await statementSnapshot())
    receipt.diskBeforeWorkload = await diskUsage()
    receipt.stage = 'workload'
    await json(path.join(evidence, 'database-run.json'), receipt)
    await action({ evidence, receipt })
    receipt.captureLimits = captureLimitMarkers([evidence, path.join(labRoot, 'state')])
    receipt.captureComplete = receipt.captureLimits.length === 0
    assert.ok(receipt.captureComplete, 'A critical capture file reached its byte limit')
    await json(path.join(evidence, 'statements-after.json'), await statementSnapshot())
  } catch (error) {
    receipt.failure = error.message
    receipt.diskAtFailure = await diskUsage().catch(() => null)
    const state = await command('docker', ['inspect', '--format', '{{json .State}}', `supabase_db_${project}`], { allowFailure: true }).catch(() => null)
    if (state?.code === 0) {
      const value = JSON.parse(state.stdout)
      receipt.databaseFailure = { status: value.Status, oomKilled: value.OOMKilled, exitCode: value.ExitCode, error: value.Error }
    }
    throw error
  } finally {
    const cleanupErrors = []
    if (stackAttempted) {
      if (postgresLog) {
        try { receipt.sqlLog = await postgresLog.close() }
        catch (error) { cleanupErrors.push(`Postgres capture: ${error.message}`) }
      }
      try { await command('supabase', ['stop', '--project-id', project, '--no-backup'], { timeout: 120000 }) }
      catch (error) { cleanupErrors.push(error.message) }
    }
    if (networkCreated) {
      try { await command('docker', ['network', 'rm', project]) }
      catch (error) { cleanupErrors.push(error.message) }
    }
    await writeFile(configFile, original)
    await rm(path.join(sourceRoot, 'supabase/.temp/start-secrets'), { recursive: true, force: true })
    await rm(path.join(labRoot, 'backup'), { recursive: true, force: true })
    receipt.cleanup = cleanupErrors.length === 0
    receipt.cleanupErrors = cleanupErrors
    receipt.stage = 'stopped'
    receipt.finishedAt = new Date().toISOString()
    await json(path.join(evidence, 'database-run.json'), receipt)
    if (cleanupErrors.length) throw new Error(`Lab cleanup failed: ${cleanupErrors.join('; ')}`)
  }
}

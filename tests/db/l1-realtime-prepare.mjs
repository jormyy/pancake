import assert from 'node:assert/strict'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { project, requireMini } from '../../scripts/perf-lab/common.mjs'
import { localKeys, networkFenceSql, sql } from '../../scripts/perf-lab/database.mjs'
import { command } from '../../scripts/perf-lab/process.mjs'
import { beginConcurrentRun } from './l1-realtime-concurrency.mjs'
import { stackCommand } from './l1-realtime-stack.mjs'

await requireMini()
assert.equal(project, 'pt4bafablel1')
const root = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-l1')
const progress = value => writeFile(path.join(root, 'prepare-progress.json'), JSON.stringify({ pid: process.pid, ...value, at: new Date().toISOString() }))
const run = async (file, args, options = {}) => {
  const settings = { timeout: 240000, ...options }
  const result = await (['docker', 'supabase'].includes(file) ? stackCommand(file, args, settings, { record: value => appendFile(path.join(root, 'stack-retries.jsonl'), JSON.stringify(value) + '\n', { mode: 0o600 }) }) : command(file, args, settings))
  await appendFile(path.join(root, 'prepare-private.log'), result.stdout + result.stderr, { mode: 0o600 })
  return result
}
await progress({ status: 'preparing-concurrent' })
const release = await beginConcurrentRun()
try {
  const config = await readFile('supabase/config.toml', 'utf8')
  assert.match(config, /project_id = "pt4bafablel1"/)
  assert.match(config, /port = 62221/)
  assert.match(config, /port = 62222/)
  await progress({ status: 'clean-restart' })
  await run('docker', ['volume', 'inspect', '--format', '{{.Name}}', 'supabase_db_pt4bafablel1'])
  await run('supabase', ['stop', '--project-id', project], { timeout: 120000 })
  const stopped = await run('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Names}}'])
  assert.equal(stopped.stdout.trim(), '', 'The stopped private Compose project must have no containers')
  const cliStopped = await run('docker', ['ps', '-a', '--filter', `label=com.supabase.cli.project=${project}`, '--format', '{{.Names}}'])
  assert.equal(cliStopped.stdout.trim(), '', 'The stopped private CLI project must have no containers')
  await run('supabase', ['start', '-x', 'studio,imgproxy,vector,logflare,supavisor,edge-runtime,postgres-meta,mailpit'])
  await run('docker', ['update', '--cpus', '0.5', '--memory', '1g', '--memory-swap', '1g', 'supabase_db_pt4bafablel1'])
  await sql("ALTER SYSTEM SET cron.launch_active_jobs='off'; ALTER SYSTEM SET pg_stat_statements.track='all'; ALTER SYSTEM SET auto_explain.log_min_duration='-1'; SELECT pg_reload_conf();")
  await sql('SELECT cron.unschedule(jobid) FROM cron.job')
  await progress({ status: 'migrating' })
  await run('supabase', ['migration', 'up', '--local', '--include-all'])
  await sql(networkFenceSql)
  await sql('SELECT cron.unschedule(jobid) FROM cron.job')
  await progress({ status: 'generating' })
  const keys = await localKeys()
  const env = { ...process.env, SUPABASE_DB_URL: keys.DB_URL, PANCAKE_TEST_DB_PORT: '62222' }
  await run(process.execPath, ['scripts/check-db-function-sources.mjs', '--write-catalog-manifest'], { env })
  await run(process.execPath, ['scripts/regenerate-release-history-attestations.mjs'], { env })
  await run(process.execPath, ['scripts/check-db-function-sources.mjs', '--check-catalog'], { env })
  const migrations = Number(await sql('SELECT count(*) FROM supabase_migrations.schema_migrations'))
  await progress({ status: 'prepared', migrations })
} catch (error) {
  await progress({ status: 'failed', error: String(error.message).replace(/eyJ[\w.-]+/g, '[redacted]').slice(0, 1200) })
  throw error
} finally { await release() }

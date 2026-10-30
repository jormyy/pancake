import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { labRoot, project, requireMini } from '../../scripts/perf-lab/common.mjs'
import { localKeys, networkFenceSql, sql } from '../../scripts/perf-lab/database.mjs'
import { command } from '../../scripts/perf-lab/process.mjs'
import { restoreLock } from './l1-realtime-stack.mjs'

await requireMini()
assert.equal(project, 'pt4bafablel1')
assert.match(await readFile('supabase/config.toml', 'utf8'), /project_id = "pt4bafablel1"/)
const receipt = { source: (await command('git', ['rev-parse', 'HEAD'])).stdout.trim(), startedAt: new Date().toISOString() }
const release = await restoreLock()
try {
await writeFile(`${labRoot}/runtime-stop`, '')
await sql("ALTER SYSTEM SET cron.launch_active_jobs='off'; SELECT pg_reload_conf(); SELECT cron.unschedule(jobid) FROM cron.job;")
await command('sh', ['-c', 'umask 077; if [ ! -f ../reset-data.sql ]; then docker exec supabase_db_pt4bafablel1 pg_dump -U supabase_admin -d postgres --data-only --schema=public --schema=auth --schema=storage > ../reset-data.sql; fi'], { timeout: 240000 })
if (process.argv[2] === 'restore') assert.match(await readFile(`${labRoot}/reset-private.log`, 'utf8'), /Finished supabase db reset/)
else {
  const reset = await command('supabase', ['db', 'reset', '--local', '--no-seed'], { timeout: 360000 })
  await writeFile(`${labRoot}/reset-private.log`, reset.stdout + reset.stderr, { mode: 0o600 })
}
await command('docker', ['update', '--cpus', '0.5', '--memory', '1g', '--memory-swap', '1g', 'supabase_db_pt4bafablel1'])
await sql("ALTER SYSTEM SET cron.launch_active_jobs='off'; ALTER SYSTEM SET pg_stat_statements.track='all'; ALTER SYSTEM SET auto_explain.log_min_duration='-1'; SELECT pg_reload_conf(); SELECT cron.unschedule(jobid) FROM cron.job;")
await sql(networkFenceSql)
receipt.history = JSON.parse(await sql("SELECT json_agg(row) FROM (SELECT version,name FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 3) row"))
assert.deepEqual(receipt.history.map(row => row.version), ['20261214004010', '20261214004000', '20261214003900'])
const data = await readFile(`${labRoot}/reset-data.sql`, 'utf8')
const partitions = [...data.matchAll(/^COPY public\.([a-z_]+)_y(\d{4})m(\d{2}) /gm)]
for (const [, parent, year, month] of partitions) await sql(`SELECT private.ensure_log_partition('public.${parent}','${year}-${month}-01')`)
await sql(`ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS versioning_status text NOT NULL DEFAULT 'DISABLED',
  ADD COLUMN IF NOT EXISTS lifecycle_configuration jsonb, ADD COLUMN IF NOT EXISTS lifecycle_configuration_generation uuid;
  ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS is_delete_marker boolean NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS is_versioned boolean NOT NULL DEFAULT false;`)
await sql(`BEGIN; SET LOCAL session_replication_role=replica;
  DO $$ DECLARE tables text; BEGIN
    SELECT string_agg(format('%I.%I',n.nspname,c.relname),',') INTO tables
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','auth','storage') AND c.relkind IN ('r','p') AND NOT c.relispartition;
    EXECUTE 'TRUNCATE '||tables||' RESTART IDENTITY CASCADE';
  END $$;`, { input: `${data}\nCOMMIT;` })
await sql('SELECT cron.unschedule(jobid) FROM cron.job')
const keys = await localKeys()
const env = { ...process.env, SUPABASE_DB_URL: keys.DB_URL, PANCAKE_TEST_DB_PORT: '62222' }
await command(process.execPath, ['scripts/check-db-function-sources.mjs', '--write-catalog-manifest'], { env })
await command(process.execPath, ['scripts/regenerate-release-history-attestations.mjs'], { env })
await command(process.execPath, ['scripts/check-db-function-sources.mjs', '--check-catalog'], { env })
receipt.restored = JSON.parse(await sql("SELECT json_build_object('leagues',(SELECT count(*) FROM public.leagues),'players',(SELECT count(*) FROM public.players),'migrations',(SELECT count(*) FROM supabase_migrations.schema_migrations))"))
receipt.status = 'pass'
receipt.finishedAt = new Date().toISOString()
await writeFile(`${labRoot}/evidence/reset-renumbered.json`, JSON.stringify(receipt, null, 2), { mode: 0o600 })
await rm(`${labRoot}/reset-data.sql`)
console.log(JSON.stringify(receipt))
} finally { await release() }

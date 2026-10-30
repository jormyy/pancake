import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chunkBackup } from './l3e-chunk-backup.mjs'

const mini = process.env.PIPELINE_MINI === '1'
const lane = mini ? path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-ui27') : '/tmp/fable-l7'
if (!mini) assert.equal(process.env.DOCKER_CONTEXT, 'desktop-linux')
const project = mini ? 'pt4bafablesr' : 'pt4bafablel7'
const port = mini ? '642' : '648'
const container = `supabase_db_${project}`
assert.equal(process.cwd(), mini ? path.join(lane, 'repo') : path.join(homedir(), 'Worktrees/pancake-l7'))
assert.equal(process.versions.node.split('.')[0], '22')
const run = (name, args, input) => execFileSync(name, args, { input, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
const sql = input => run('docker', ['exec', '-i', container, 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], input)
const original = run('git', ['show', 'HEAD:supabase/config.toml'])
let stopping = false, attempted = false
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { stopping = true })
mkdirSync(path.join(lane, 'evidence'), { recursive: true })
try {
  mkdirSync(path.join(lane, 'backup'), { recursive: true })
  if (!mini) for (const file of ['schema.sql', 'data.sql']) cpSync(path.join(homedir(), 'Documents/pancake-db-backup-2026-10-28', file), path.join(lane, 'backup', file))
  assert.equal(run('docker', ['ps', '-aq', '--filter', `label=com.supabase.cli.project=${project}`]).trim(), '')
  const config = original.replace(/^project_id = .*$/m, `project_id = "${project}"`)
    .replace(/\b543(\d\d)\b/g, `${port}$1`).replace('inspector_port = 8083', `inspector_port = ${port}83`)
    .replace(/(\[db.migrations\][\s\S]*?enabled = )true/, '$1false')
    .replace(/(\[db.seed\][\s\S]*?enabled = )true/, '$1false')
  writeFileSync('supabase/config.toml', config)
  attempted = true
  process.stdout.write('Starting private database.\n')
  run('supabase', ['db', 'start'])
  sql("ALTER SYSTEM SET cron.launch_active_jobs='off'; SELECT pg_reload_conf();")
  sql(`CREATE SCHEMA pipeline_night_lab;
    CREATE FUNCTION pipeline_night_lab.local_http_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.url !~ '^http://(127[.]0[.]0[.]1|localhost|host[.]docker[.]internal):${port}[0-9]{2}(/|$)' THEN RAISE EXCEPTION 'Private pipeline stack blocks external HTTP'; END IF;
      RETURN NEW; END; $$;
    CREATE TRIGGER pipeline_night_http BEFORE INSERT OR UPDATE ON net.http_request_queue FOR EACH ROW EXECUTE FUNCTION pipeline_night_lab.local_http_only();`)
  const prefix = path.join(lane, 'schema-baseline')
  mkdirSync(path.join(prefix, 'supabase/migrations'), { recursive: true })
  writeFileSync(path.join(prefix, 'supabase/config.toml'), config.replace(/(\[db.migrations\][\s\S]*?enabled = )false/, '$1true'))
  const baseline = JSON.parse(readFileSync('tests/e2e/db-security-catalog-attestations.json', 'utf8')).preMigration
  const files = readdirSync('supabase/migrations').filter(file => /^\d{14}_.*\.sql$/.test(file)).sort()
  const initial = files.filter(file => file.slice(0, 14) <= baseline.version)
  assert.equal(initial.length, baseline.count)
  for (const file of initial) cpSync(`supabase/migrations/${file}`, `${prefix}/supabase/migrations/${file}`)
  process.stdout.write('Applying backup schema baseline.\n')
  run('supabase', ['migration', 'up', '--local', '--include-all', '--workdir', prefix])
  const hashes = {}
  for (const file of ['schema.sql', 'data.sql']) hashes[file] = createHash('sha256').update(readFileSync(path.join(lane, 'backup', file))).digest('hex')
  const chunked = chunkBackup(readFileSync(path.join(lane, 'backup/data.sql'), 'utf8'))
  const verified = chunkBackup(chunked.sql, Number.MAX_SAFE_INTEGER)
  assert.equal(verified.valuesSha256, chunked.valuesSha256)
  assert.equal(verified.rows, chunked.rows)
  const tables = [...new Set([...chunked.sql.matchAll(/^INSERT INTO ("[a-z_]+"\."[a-z_]+")\s*\(/gm)].map(match => match[1]))]
  assert.ok(tables.includes('"public"."players"'))
  sql(`ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS versioning_status text NOT NULL DEFAULT 'DISABLED',
    ADD COLUMN IF NOT EXISTS lifecycle_configuration jsonb, ADD COLUMN IF NOT EXISTS lifecycle_configuration_generation uuid;
    ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS archived_at timestamptz,
    ADD COLUMN IF NOT EXISTS is_delete_marker boolean NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS is_versioned boolean NOT NULL DEFAULT false;`)
  process.stdout.write(`Restoring ${chunked.rows} verified backup rows.\n`)
  sql(`BEGIN;SET LOCAL session_replication_role=replica;TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE;\n${chunked.sql}\n
    SET LOCAL session_replication_role=replica;
    TRUNCATE auth.sessions,auth.refresh_tokens,auth.mfa_amr_claims,public.web_push_subscriptions,public.notification_outbox CASCADE;
    TRUNCATE net.http_request_queue;
    UPDATE public.profiles SET push_token=NULL,push_token_revocation_hash=NULL;
    UPDATE auth.users SET encrypted_password='',confirmation_token='',recovery_token='',email_change_token_new='',email_change='',email_change_token_current='',reauthentication_token='';COMMIT;`)
  rmSync(path.join(lane, 'backup'), { recursive: true })
  rmSync(prefix, { recursive: true })
  writeFileSync('supabase/config.toml', config.replace(/(\[db.migrations\][\s\S]*?enabled = )false/, '$1true'))
  process.stdout.write('Migrating restored backup to branch HEAD.\n')
  run('supabase', ['migration', 'up', '--local', '--include-all'])
  sql('SELECT cron.unschedule(jobid) FROM cron.job;')
  sql("ALTER SYSTEM SET shared_buffers='224MB'; ALTER SYSTEM SET effective_cache_size='384MB'; ALTER SYSTEM SET pg_stat_statements.track='all'; ALTER SYSTEM SET log_min_duration_statement='-1'; ALTER SYSTEM SET auto_explain.log_min_duration='-1'; SELECT pg_reload_conf();")
  run('docker', ['update', '--cpus=2', '--memory=1g', '--memory-swap=1g', container])
  run('docker', ['restart', container])
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    try { sql('SELECT 1;'); ready = true; break } catch { await delay(1000) }
  }
  assert.ok(ready)
  sql('ANALYZE;')
  const settings = JSON.parse(sql("SELECT jsonb_build_object('shared_buffers',current_setting('shared_buffers'),'effective_cache_size',current_setting('effective_cache_size'),'leagues',(SELECT count(*) FROM public.leagues),'players',(SELECT count(*) FROM public.players),'gameRows',(SELECT count(*) FROM public.player_game_stats),'games',(SELECT count(*) FROM public.nba_games));"))
  const receipt = { source: run('git', ['rev-parse', 'HEAD']).trim(), hashes, backupRows: chunked.rows, tupleHash: chunked.valuesSha256, settings, limits: JSON.parse(run('docker', ['inspect', '--format', '{{json .HostConfig}}', container])), concurrent: true }
  writeFileSync(path.join(lane, 'evidence/stack.json'), JSON.stringify(receipt, null, 2))
  writeFileSync(path.join(lane, 'ready'), new Date().toISOString())
  process.stdout.write(`Ready: ${JSON.stringify(settings)}\n`)
  while (!stopping && !existsSync(path.join(lane, 'stop'))) await delay(1000)
} catch (error) {
  process.stderr.write(`${error.stack}\n${error.stderr?.toString().slice(-12000) ?? ''}\n`)
  process.exitCode = 1
} finally {
  if (attempted) {
    try { run('supabase', ['stop', '--project-id', project, '--no-backup']) } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
    writeFileSync('supabase/config.toml', original)
  }
  for (const name of ['backup', 'schema-baseline', 'ready', 'stop']) rmSync(path.join(lane, name), { recursive: true, force: true })
  process.stdout.write('Private stack stopped; backup copies removed.\n')
}

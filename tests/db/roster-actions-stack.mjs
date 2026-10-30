import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { chunkBackup } from './l3e-chunk-backup.mjs'
import { acquire } from './roster-actions-lock.mjs'

const lane = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-a2')
const shared = path.join(homedir(), 'pancake-t_4ba51e0d/shared')
assert.equal(process.cwd(), path.join(lane, 'repo'))
assert.equal(process.versions.node.split('.')[0], '22')
const project = 'pt4bafablea2'
const container = `supabase_db_${project}`
const run = (name, args, input) => execFileSync(name, args, { input, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 600000 })
const sql = input => run('docker', ['exec', '-i', container, 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], input)
const ready = path.join(lane, 'ready')
const stop = path.join(lane, 'stop')
const prefix = path.join(lane, 'prefix')
let release
let started = false
let quitting = false
process.on('SIGTERM', () => { quitting = true })
process.on('SIGINT', () => { quitting = true })
process.on('SIGHUP', () => { quitting = true })
mkdirSync(path.join(lane, 'evidence'), { recursive: true })
rmSync(ready, { force: true })
rmSync(stop, { force: true })
try {
  while (!release && !quitting) {
    release = await acquire(path.join(shared, 'stack-slot-3.lock'), 'roster-actions')
    if (!release) { console.log('Waiting for mini stack slot 3.'); await pause(30000) }
  }
  assert.ok(release, 'Stack startup interrupted before acquiring a slot')
  const original = run('git', ['show', 'HEAD:supabase/config.toml'])
  const config = original.replace(/^project_id = .*$/m, `project_id = "${project}"`).replace(/\b543(\d\d)\b/g, '644$1')
    .replace('inspector_port = 8083', 'inspector_port = 64483')
    .replace(/(\[db.migrations\][\s\S]*?enabled = )true/, '$1false')
    .replace(/(\[db.seed\][\s\S]*?enabled = )true/, '$1false')
  writeFileSync('supabase/config.toml', config)
  started = true
  run('supabase', ['start', '-x', 'studio,imgproxy,logflare,vector,supavisor,mailpit,realtime,storage-api,edge-runtime,postgres-meta'])
  sql("ALTER SYSTEM SET cron.launch_active_jobs='off'; SELECT pg_reload_conf();")
  if (!process.argv.includes('--resume')) {
    mkdirSync(path.join(prefix, 'supabase/migrations'), { recursive: true })
    writeFileSync(path.join(prefix, 'supabase/config.toml'), config.replace(/(\[db.migrations\][\s\S]*?enabled = )false/, '$1true'))
    const baseline = JSON.parse(readFileSync('tests/e2e/db-security-catalog-attestations.json', 'utf8')).preMigration.version
    const files = readdirSync('supabase/migrations').filter(file => /^\d{14}_.*\.sql$/.test(file)).sort()
    for (const file of files.filter(file => file.slice(0, 14) <= baseline)) cpSync(`supabase/migrations/${file}`, `${prefix}/supabase/migrations/${file}`)
    run('supabase', ['migration', 'up', '--local', '--include-all', '--workdir', prefix])
    sql(`CREATE SCHEMA IF NOT EXISTS roster_actions_lab;
      CREATE OR REPLACE FUNCTION roster_actions_lab.local_http_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.url !~ '^http://(127[.]0[.]0[.]1|localhost|host[.]lima[.]internal):644[0-9]{2}(/|$)' THEN RAISE EXCEPTION 'Private stack blocks external HTTP'; END IF;
        RETURN NEW; END; $$;
      DROP TRIGGER IF EXISTS roster_actions_http ON net.http_request_queue;
      CREATE TRIGGER roster_actions_http BEFORE INSERT OR UPDATE ON net.http_request_queue FOR EACH ROW EXECUTE FUNCTION roster_actions_lab.local_http_only();`)
    const manifest = JSON.parse(readFileSync(path.join(lane, 'backup/manifest.json'), 'utf8'))
    for (const file of ['schema.sql', 'data.sql']) assert.equal(createHash('sha256').update(readFileSync(path.join(lane, 'backup', file))).digest('hex'), manifest[file])
    const schema = readFileSync(path.join(lane, 'backup/schema.sql'), 'utf8')
    assert.ok(schema.includes('CREATE TABLE'))
    const data = chunkBackup(readFileSync(path.join(lane, 'backup/data.sql'), 'utf8'))
    const verification = chunkBackup(data.sql, Number.MAX_SAFE_INTEGER)
    assert.equal(verification.valuesSha256, data.valuesSha256)
    assert.equal(verification.rows, data.rows)
    const tables = [...new Set([...data.sql.matchAll(/^INSERT INTO ("[a-z_]+"\."[a-z_]+")\s*\(/gm)].map(match => match[1]))]
    assert.ok(tables.includes('"public"."leagues"'))
    sql(`ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS versioning_status text NOT NULL DEFAULT 'DISABLED',
      ADD COLUMN IF NOT EXISTS lifecycle_configuration jsonb, ADD COLUMN IF NOT EXISTS lifecycle_configuration_generation uuid;
      ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS archived_at timestamptz,
      ADD COLUMN IF NOT EXISTS is_delete_marker boolean NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS is_versioned boolean NOT NULL DEFAULT false;`)
    sql(`BEGIN;SET LOCAL session_replication_role=replica;TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE;\n${data.sql}\n
      SET LOCAL session_replication_role=replica;
      TRUNCATE auth.sessions,auth.refresh_tokens,auth.mfa_amr_claims,public.web_push_subscriptions,public.notification_outbox CASCADE;
      TRUNCATE net.http_request_queue;
      UPDATE public.profiles SET push_token=NULL,push_token_revocation_hash=NULL;
      UPDATE auth.users SET encrypted_password='',confirmation_token='',recovery_token='',email_change_token_new='',email_change='',email_change_token_current='',reauthentication_token='';COMMIT;`)
    writeFileSync(path.join(lane, 'evidence/restore.json'), JSON.stringify({ rows: data.rows, tupleSha256: data.valuesSha256, baseline, tables: tables.length }))
    rmSync(path.join(lane, 'backup'), { recursive: true })
    for (const file of files.filter(file => file.slice(0, 14) > baseline)) cpSync(`supabase/migrations/${file}`, `${prefix}/supabase/migrations/${file}`)
    run('supabase', ['migration', 'up', '--local', '--include-all', '--workdir', prefix])
    sql('SELECT cron.unschedule(jobid) FROM cron.job; ANALYZE;')
  }
  const buffersBefore = sql("SHOW shared_buffers;").trim()
  sql("ALTER SYSTEM SET shared_buffers='224MB'; ALTER SYSTEM SET effective_cache_size='384MB'; ALTER SYSTEM SET pg_stat_statements.track='all'; ALTER SYSTEM SET track_functions='all';")
  if (buffersBefore !== '224MB') {
    run('supabase', ['stop', '--project-id', project])
    run('supabase', ['start', '-x', 'studio,imgproxy,logflare,vector,supavisor,mailpit,realtime,storage-api,edge-runtime,postgres-meta'])
  } else sql('SELECT pg_reload_conf();')
  run('docker', ['update', '--cpus=2', '--memory=1g', '--memory-swap=1g', container])
  for (let attempt = 0; attempt < 60; attempt++) {
    try { sql('SELECT 1;'); break } catch { await pause(1000) }
  }
  const settings = JSON.parse(sql("SELECT jsonb_build_object('shared_buffers',current_setting('shared_buffers'),'effective_cache_size',current_setting('effective_cache_size'),'leagues',(SELECT count(*) FROM public.leagues),'players',(SELECT count(*) FROM public.players),'stats',(SELECT count(*) FROM public.player_game_stats));"))
  assert.equal(settings.shared_buffers, '224MB')
  assert.equal(settings.effective_cache_size, '384MB')
  const resources = JSON.parse(run('docker', ['inspect', '--format', '{{json .HostConfig}}', container]))
  assert.equal(resources.NanoCpus, 2000000000)
  assert.equal(resources.Memory, 1073741824)
  writeFileSync(path.join(lane, 'evidence/settings.json'), JSON.stringify({ ...settings, cpus: resources.NanoCpus / 1000000000, memoryBytes: resources.Memory }))
  writeFileSync(ready, `${process.pid}\n`)
  console.log(JSON.stringify({ ready: true, ...settings }))
  while (!quitting && !existsSync(stop)) await pause(1000)
} finally {
  try { if (started) run('supabase', ['stop', '--project-id', project]) } finally {
  writeFileSync('supabase/config.toml', run('git', ['show', 'HEAD:supabase/config.toml']))
  rmSync(prefix, { recursive: true, force: true })
  rmSync(path.join(lane, 'backup'), { recursive: true, force: true })
  rmSync(ready, { force: true })
  rmSync(stop, { force: true })
  if (release) await release()
  }
}

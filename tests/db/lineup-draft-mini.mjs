import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { acquireLock } from './lineup-draft-lock.mjs'
import { chunkBackup } from './l3e-chunk-backup.mjs'

const lane = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-a3')
assert.equal(process.cwd(), path.join(lane, 'repo'))
assert.equal(process.versions.node.split('.')[0], '22')
const project = 'pt4bafablea3'
const container = `supabase_db_${project}`
const run = (name, args, input) => execFileSync(name, args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
const sql = input => run('docker', ['exec', '-i', container, 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], input)
const mode = 'setup'
mkdirSync(path.join(lane, 'evidence'), { recursive: true })
async function setup() {
if (mode === 'setup' || mode === 'resume') {
    if (mode === 'setup') assert.equal(run('docker', ['ps', '-aq', '--filter', `label=com.supabase.cli.project=${project}`]).trim(), '')
    const original = run('git', ['show', 'HEAD:supabase/config.toml'])
    const config = original.replace(/^project_id = .*$/m, `project_id = "${project}"`).replace(/\b543(\d\d)\b/g, '645$1')
        .replace('inspector_port = 8083', 'inspector_port = 64583')
        .replace(/(\[db.migrations\][\s\S]*?enabled = )true/, '$1false')
        .replace(/(\[db.seed\][\s\S]*?enabled = )true/, '$1false')
    writeFileSync('supabase/config.toml', config)
    process.stdout.write('Starting private stack.\n')
    run('supabase', ['start', '-x', 'studio,imgproxy,logflare,vector,supavisor,mailpit,realtime,storage-api,edge-runtime'])
    sql("ALTER SYSTEM SET cron.launch_active_jobs='off'; SELECT pg_reload_conf();")
    const prefix = path.join(lane, 'prefix')
    mkdirSync(path.join(prefix, 'supabase/migrations'), { recursive: true })
    writeFileSync(path.join(prefix, 'supabase/config.toml'), config.replace(/(\[db.migrations\][\s\S]*?enabled = )false/, '$1true'))
    const baseline = JSON.parse(readFileSync('tests/e2e/db-security-catalog-attestations.json', 'utf8')).preMigration.version
    const files = readdirSync('supabase/migrations').filter(file => /^\d{14}_.*\.sql$/.test(file)).sort()
    for (const file of files.filter(file => file.slice(0, 14) <= baseline)) cpSync(`supabase/migrations/${file}`, `${prefix}/supabase/migrations/${file}`)
    process.stdout.write('Applying backup schema baseline.\n')
    run('supabase', ['migration', 'up', '--local', '--include-all', '--workdir', prefix])
    sql(`CREATE SCHEMA IF NOT EXISTS lineup_draft_lab;
    CREATE OR REPLACE FUNCTION lineup_draft_lab.local_http_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.url !~ '^http://(127[.]0[.]0[.]1|localhost|host[.]lima[.]internal):645[0-9]{2}(/|$)' THEN RAISE EXCEPTION 'Private stack blocks external HTTP'; END IF;
      RETURN NEW; END; $$;
    DROP TRIGGER IF EXISTS lineup_draft_lab_http ON net.http_request_queue;
    CREATE TRIGGER lineup_draft_lab_http BEFORE INSERT OR UPDATE ON net.http_request_queue FOR EACH ROW EXECUTE FUNCTION lineup_draft_lab.local_http_only();`)
    const chunked = chunkBackup(readFileSync(path.join(lane, 'backup/data.sql'), 'utf8'))
    const verified = chunkBackup(chunked.sql, Number.MAX_SAFE_INTEGER)
    assert.equal(verified.valuesSha256, chunked.valuesSha256)
    assert.equal(verified.rows, chunked.rows)
    const data = chunked.sql
    process.stdout.write(`Backup tuple parity: ${chunked.rows} rows, ${chunked.statements} bounded statements.\n`)
    run('docker', ['update', '--cpus', '2', '--memory', '1g', '--memory-swap', '1g', container])
    sql("ALTER SYSTEM SET shared_buffers='224MB'; ALTER SYSTEM SET effective_cache_size='384MB';");
    run('docker', ['restart', container])
    for (let attempt = 0; attempt < 60; attempt++) {
      try { sql('SELECT 1'); break } catch { await new Promise(resolve => setTimeout(resolve, 1000)) }
    }
    assert.ok(readFileSync(path.join(lane, 'backup/schema.sql'), 'utf8').includes('CREATE TABLE'))
    const tables = [...new Set([...data.matchAll(/^INSERT INTO ("[a-z_]+"\."[a-z_]+")\s*\(/gm)].map(match => match[1]))]
    assert.ok(tables.includes('"public"."leagues"'))
    sql(`ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS versioning_status text NOT NULL DEFAULT 'DISABLED',
      ADD COLUMN IF NOT EXISTS lifecycle_configuration jsonb, ADD COLUMN IF NOT EXISTS lifecycle_configuration_generation uuid;
      ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS archived_at timestamptz,
      ADD COLUMN IF NOT EXISTS is_delete_marker boolean NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS is_versioned boolean NOT NULL DEFAULT false;`)
    process.stdout.write('Restoring production-shaped tables.\n')
    sql(`BEGIN;SET LOCAL session_replication_role=replica;TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE;\n${data}\n
      SET LOCAL session_replication_role=replica;
      TRUNCATE auth.sessions,auth.refresh_tokens,auth.mfa_amr_claims,public.web_push_subscriptions,public.notification_outbox CASCADE;
      TRUNCATE net.http_request_queue;
      UPDATE public.profiles SET push_token=NULL,push_token_revocation_hash=NULL;
      UPDATE auth.users SET encrypted_password='',confirmation_token='',recovery_token='',email_change_token_new='',email_change='',email_change_token_current='',reauthentication_token='';COMMIT;`)
    rmSync(path.join(lane, 'backup'), { recursive: true })
    for (const file of files.filter(file => file.slice(0, 14) > baseline)) cpSync(`supabase/migrations/${file}`, `${prefix}/supabase/migrations/${file}`)
    process.stdout.write('Migrating backup to branch baseline.\n')
    run('supabase', ['migration', 'up', '--local', '--include-all', '--workdir', prefix])
    rmSync(prefix, { recursive: true })
    sql('SELECT cron.unschedule(jobid) FROM cron.job; ANALYZE;')
    process.stdout.write(sql("SELECT jsonb_build_object('leagues',(SELECT count(*) FROM public.leagues),'players',(SELECT count(*) FROM public.players),'gameRows',(SELECT count(*) FROM public.player_game_stats),'rosters',(SELECT count(*) FROM public.roster_players));"))
}
}

let release
let interrupted = false
let finish
let lifetime
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { interrupted = true; finish?.() })
try {
  for (let slot = 1; slot <= 3; slot++) {
    release = acquireLock(`stack-slot-${slot}.lock`)
    if (release) break
  }
  assert.ok(release, 'All mini stack slots are occupied')
  await setup()
  process.stdout.write('READY: private lineup/draft stack\n')
  if (!interrupted) await new Promise(resolve => {
    finish = resolve
    lifetime = setTimeout(resolve, 170 * 60 * 1000)
  })
} finally {
  clearTimeout(lifetime)
  if (release) {
    try { run('supabase', ['stop', '--project-id', project, '--no-backup']) }
    finally {
      writeFileSync('supabase/config.toml', run('git', ['show', 'HEAD:supabase/config.toml']))
      rmSync(path.join(lane, 'backup'), { recursive: true, force: true })
      release()
    }
  }
}

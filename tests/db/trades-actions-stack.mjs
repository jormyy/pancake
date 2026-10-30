import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { chunkBackup } from './l3e-chunk-backup.mjs'

const lane = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-a1')
assert.equal(process.cwd(), path.join(lane, 'repo'))
assert.equal(process.versions.node.split('.')[0], '22')
const project = 'pt4bafablea1'
const container = `supabase_db_${project}`
const shared = path.join(homedir(), 'pancake-t_4ba51e0d/shared')
const run = (name, args, input) => execFileSync(name, args, { input, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
const sql = input => run('docker', ['exec', '-i', container, 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], input)

export function acquire(directory) {
  try { mkdirSync(directory) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const owner = JSON.parse(readFileSync(path.join(directory, 'owner.json'), 'utf8'))
    let dead = false
    try { process.kill(owner.pid, 0) } catch (failure) { if (failure.code === 'ESRCH') dead = true; else throw failure }
    if (!dead && !(Date.now() - Date.parse(owner.started ?? owner.startedAt) > 3 * 3600000)) return false
    rmSync(directory, { recursive: true })
    mkdirSync(directory)
  }
  writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ lane: 'fable-a1', pid: process.pid, started: new Date().toISOString() }))
  return true
}

let slot
let stopping = false
const cleanup = () => {
  if (stopping) return
  stopping = true
  if (slot) {
    try { run('supabase', ['stop', '--project-id', project, '--no-backup']) } finally {
      writeFileSync('supabase/config.toml', run('git', ['show', 'HEAD:supabase/config.toml']))
      rmSync(slot, { recursive: true, force: true })
    }
  }
  rmSync(path.join(lane, 'backup'), { recursive: true, force: true })
  rmSync(path.join(lane, 'ready'), { force: true })
}
process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })

try {
  for (let attempt = 0; !slot && attempt < 180; attempt++) {
    for (let index = 1; index <= 3; index++) {
      const directory = path.join(shared, `stack-slot-${index}.lock`)
      if (acquire(directory)) { slot = directory; break }
    }
    if (!slot) { process.stdout.write('Waiting for a stack slot.\n'); await pause(30000) }
  }
  assert.ok(slot, 'No mini stack slot is available')
  const original = run('git', ['show', 'HEAD:supabase/config.toml'])
  const config = original.replace(/^project_id = .*$/m, `project_id = "${project}"`).replace(/\b543(\d\d)\b/g, '643$1')
    .replace('inspector_port = 8083', 'inspector_port = 64383')
    .replace(/(\[db.migrations\][\s\S]*?enabled = )true/, '$1false')
    .replace(/(\[db.seed\][\s\S]*?enabled = )true/, '$1false')
  writeFileSync('supabase/config.toml', config)
  process.stdout.write('Starting the private trade stack.\n')
  run('supabase', ['start', '-x', 'studio,imgproxy,logflare,vector,supavisor,mailpit,realtime,storage-api,edge-runtime,postgres-meta'])
  run('docker', ['update', '--cpus=2', '--memory=1g', '--memory-swap=1g', container])
  sql("ALTER SYSTEM SET cron.launch_active_jobs='off'; ALTER SYSTEM SET shared_buffers='224MB'; ALTER SYSTEM SET effective_cache_size='384MB'; ALTER SYSTEM SET pg_stat_statements.track='all'; SELECT pg_reload_conf();")
  run('docker', ['restart', container])
  for (let attempt = 0; attempt < 60; attempt++) {
    try { sql('SELECT 1'); break } catch { await pause(1000) }
  }
  const prefix = path.join(lane, 'prefix')
  mkdirSync(path.join(prefix, 'supabase/migrations'), { recursive: true })
  writeFileSync(path.join(prefix, 'supabase/config.toml'), config.replace(/(\[db.migrations\][\s\S]*?enabled = )false/, '$1true'))
  const baseline = JSON.parse(readFileSync('tests/e2e/db-security-catalog-attestations.json', 'utf8')).preMigration.version
  const files = readdirSync('supabase/migrations').filter(file => /^\d{14}_.*\.sql$/.test(file)).sort()
  for (const file of files.filter(file => file.slice(0, 14) <= baseline)) cpSync(`supabase/migrations/${file}`, `${prefix}/supabase/migrations/${file}`)
  process.stdout.write('Applying the backup schema baseline.\n')
  run('supabase', ['migration', 'up', '--local', '--include-all', '--workdir', prefix])
  sql(`CREATE SCHEMA trades_actions_lab;
    CREATE FUNCTION trades_actions_lab.local_http_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.url !~ '^http://(127[.]0[.]0[.]1|localhost|host[.]lima[.]internal):643[0-9]{2}(/|$)' THEN RAISE EXCEPTION 'Private stack blocks external HTTP'; END IF;
      RETURN NEW; END; $$;
    CREATE TRIGGER trades_actions_lab_http BEFORE INSERT OR UPDATE ON net.http_request_queue FOR EACH ROW EXECUTE FUNCTION trades_actions_lab.local_http_only();`)
  const source = readFileSync(path.join(lane, 'backup/data.sql'), 'utf8')
  assert.ok(readFileSync(path.join(lane, 'backup/schema.sql'), 'utf8').includes('CREATE TABLE'))
  const data = chunkBackup(source)
  const verified = chunkBackup(data.sql, Number.MAX_SAFE_INTEGER)
  assert.equal(verified.valuesSha256, data.valuesSha256)
  assert.equal(verified.rows, data.rows)
  mkdirSync(path.join(lane, 'evidence'), { recursive: true })
  writeFileSync(path.join(lane, 'evidence/restore.json'), JSON.stringify({ sha256: createHash('sha256').update(source).digest('hex'), rows: data.rows, statements: data.statements, valuesSha256: data.valuesSha256 }))
  const tables = [...new Set([...data.sql.matchAll(/^INSERT INTO ("[a-z_]+"\."[a-z_]+")\s*\(/gm)].map(match => match[1]))]
  process.stdout.write(`Restoring ${data.rows} verified backup rows in bounded statements.\n`)
  sql(`ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS versioning_status text NOT NULL DEFAULT 'DISABLED', ADD COLUMN IF NOT EXISTS lifecycle_configuration jsonb, ADD COLUMN IF NOT EXISTS lifecycle_configuration_generation uuid;
    ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS archived_at timestamptz, ADD COLUMN IF NOT EXISTS is_delete_marker boolean NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS is_versioned boolean NOT NULL DEFAULT false;`)
  sql(`BEGIN; SET LOCAL session_replication_role=replica; SET LOCAL statement_timeout=0; TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE;
    ${data.sql}
    TRUNCATE auth.sessions,auth.refresh_tokens,auth.mfa_amr_claims,public.web_push_subscriptions,public.notification_outbox CASCADE;
    TRUNCATE net.http_request_queue;
    UPDATE public.profiles SET push_token=NULL,push_token_revocation_hash=NULL;
    UPDATE auth.users SET encrypted_password='',confirmation_token='',recovery_token='',email_change_token_new='',email_change='',email_change_token_current='',reauthentication_token=''; COMMIT;`)
  rmSync(path.join(lane, 'backup'), { recursive: true })
  for (const file of files.filter(file => file.slice(0, 14) > baseline)) cpSync(`supabase/migrations/${file}`, `${prefix}/supabase/migrations/${file}`)
  process.stdout.write('Migrating the restored backup to this branch.\n')
  run('supabase', ['migration', 'up', '--local', '--include-all', '--workdir', prefix])
  rmSync(prefix, { recursive: true })
  run('psql', ['postgresql://supabase_admin:postgres@127.0.0.1:64322/postgres', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-f', 'tests/db/trades-actions-values.sql'])
  sql('ANALYZE;')
  process.stdout.write(sql("SELECT jsonb_build_object('shared_buffers',current_setting('shared_buffers'),'effective_cache_size',current_setting('effective_cache_size'),'cron',current_setting('cron.launch_active_jobs'),'leagues',(SELECT count(*) FROM public.leagues),'players',(SELECT count(*) FROM public.players),'stats',(SELECT count(*) FROM public.player_game_stats));"))
  writeFileSync(path.join(lane, 'ready'), String(process.pid))
  while (!existsSync(path.join(lane, 'stop'))) await pause(1000)
  rmSync(path.join(lane, 'stop'))
} catch (error) {
  process.stderr.write(`${error.message.slice(0, 2000)}\n`)
  process.exitCode = 1
} finally { cleanup() }

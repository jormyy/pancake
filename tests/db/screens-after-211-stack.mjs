import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { chunkBackup } from './l3e-chunk-backup.mjs'

const lane = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-ui27')
assert.equal(process.cwd(), path.join(lane, 'repo'))
assert.equal(process.versions.node.split('.')[0], '22')
const project = 'pt4bafablesr'
const container = `supabase_db_${project}`
const run = (name, args, input) => execFileSync(name, args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
const sql = input => run('docker', ['exec', '-i', container, 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], input)
const mode = process.argv[2]
mkdirSync(path.join(lane, 'evidence'), { recursive: true })
if (mode === 'setup' || mode === 'resume') {
    const hashes = JSON.parse(readFileSync(path.join(lane, 'backup/manifest.json'), 'utf8'))
    for (const file of ['schema.sql', 'data.sql']) assert.equal(createHash('sha256').update(readFileSync(path.join(lane, 'backup', file))).digest('hex'), hashes[file])
    if (mode === 'setup') assert.equal(run('docker', ['ps', '-aq', '--filter', `label=com.supabase.cli.project=${project}`]).trim(), '')
    const original = run('git', ['show', 'HEAD:supabase/config.toml'])
    const config = original.replace(/^project_id = .*$/m, `project_id = "${project}"`).replace(/\b543(\d\d)\b/g, '642$1')
        .replace('inspector_port = 8083', 'inspector_port = 64283')
        .replace(/(\[db.migrations\][\s\S]*?enabled = )true/, '$1false')
        .replace(/(\[db.seed\][\s\S]*?enabled = )true/, '$1false')
    writeFileSync('supabase/config.toml', config)
    process.stdout.write('Starting private stack.\n')
    run('supabase', ['start', '-x', 'studio,imgproxy,vector,logflare,supavisor,edge-runtime,postgres-meta,mailpit'])
    sql("ALTER SYSTEM SET cron.launch_active_jobs='off'; SELECT pg_reload_conf();")
    const prefix = path.join(lane, 'prefix')
    mkdirSync(path.join(prefix, 'supabase/migrations'), { recursive: true })
    writeFileSync(path.join(prefix, 'supabase/config.toml'), config.replace(/(\[db.migrations\][\s\S]*?enabled = )false/, '$1true'))
    const baseline = JSON.parse(readFileSync('tests/e2e/db-security-catalog-attestations.json', 'utf8')).preMigration.version
    const releaseFiles = new Set(run('git', ['ls-tree', '-r', '--name-only', '892b6bca', 'supabase/migrations']).trim().split('\n').map(file => path.basename(file)))
    const files = readdirSync('supabase/migrations').filter(file => /^\d{14}_.*\.sql$/.test(file)).sort()
    for (const file of files.filter(file => file.slice(0, 14) <= baseline)) cpSync(`supabase/migrations/${file}`, `${prefix}/supabase/migrations/${file}`)
    process.stdout.write('Applying backup schema baseline.\n')
    run('supabase', ['migration', 'up', '--local', '--include-all', '--workdir', prefix])
    sql(`CREATE SCHEMA IF NOT EXISTS screens_after_211_lab;
    CREATE OR REPLACE FUNCTION screens_after_211_lab.local_http_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.url !~ '^http://(127[.]0[.]0[.]1|localhost|host[.]lima[.]internal):642[0-9]{2}(/|$)' THEN RAISE EXCEPTION 'Private stack blocks external HTTP'; END IF;
      RETURN NEW; END; $$;
    DROP TRIGGER IF EXISTS screens_after_211_lab_http ON net.http_request_queue;
    CREATE TRIGGER screens_after_211_lab_http BEFORE INSERT OR UPDATE ON net.http_request_queue FOR EACH ROW EXECUTE FUNCTION screens_after_211_lab.local_http_only();`)
    const chunked = chunkBackup(readFileSync(path.join(lane, 'backup/data.sql'), 'utf8'))
    const verified = chunkBackup(chunked.sql, Number.MAX_SAFE_INTEGER)
    assert.equal(verified.valuesSha256, chunked.valuesSha256)
    assert.equal(verified.rows, chunked.rows)
    const data = chunked.sql
    process.stdout.write(`Backup tuple parity: ${chunked.rows} rows, ${chunked.statements} bounded statements.\n`)
    run('docker', ['update', '--memory', '4g', '--memory-swap', '4g', container])
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
    for (const file of files.filter(file => file.slice(0, 14) > baseline && releaseFiles.has(file))) cpSync(`supabase/migrations/${file}`, `${prefix}/supabase/migrations/${file}`)
    process.stdout.write('Migrating backup to release 2.10.2.\n')
    run('supabase', ['migration', 'up', '--local', '--include-all', '--workdir', prefix])
    rmSync(prefix, { recursive: true })
    sql('SELECT cron.unschedule(jobid) FROM cron.job;')
    sql('ANALYZE;')
    process.stdout.write(sql("SELECT jsonb_build_object('leagues',(SELECT count(*) FROM public.leagues),'players',(SELECT count(*) FROM public.players),'gameRows',(SELECT count(*) FROM public.player_game_stats),'rosters',(SELECT count(*) FROM public.roster_players));"))
} else if (mode === 'migrate') {
    writeFileSync('supabase/config.toml', readFileSync('supabase/config.toml', 'utf8').replace(/(\[db.migrations\][\s\S]*?enabled = )false/, '$1true'))
    const release = process.argv[3]
    if (release) {
        assert.equal(release, '1e696f25')
        const prefix = path.join(lane, 'upgrade')
        mkdirSync(path.join(prefix, 'supabase/migrations'), { recursive: true })
        writeFileSync(path.join(prefix, 'supabase/config.toml'), readFileSync('supabase/config.toml', 'utf8'))
        const files = run('git', ['ls-tree', '-r', '--name-only', release, 'supabase/migrations']).trim().split('\n')
        for (const file of files) cpSync(file, path.join(prefix, file))
        try { run('supabase', ['migration', 'up', '--local', '--include-all', '--workdir', prefix]) }
        finally { rmSync(prefix, { recursive: true }) }
    } else run('supabase', ['migration', 'up', '--local', '--include-all'])
    sql('SELECT cron.unschedule(jobid) FROM cron.job;')
    sql('ANALYZE;')
    process.stdout.write('Private candidate migration applied.\n')
} else if (mode === 'stop') {
    run('supabase', ['stop', '--project-id', project, '--no-backup'])
    writeFileSync('supabase/config.toml', run('git', ['show', 'HEAD:supabase/config.toml']))
    if (existsSync(path.join(lane, 'backup'))) rmSync(path.join(lane, 'backup'), { recursive: true })
} else {
    throw new Error('Choose setup, migrate, or stop')
}

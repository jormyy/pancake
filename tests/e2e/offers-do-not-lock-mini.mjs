import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { chunkBackup } from '../db/l3e-chunk-backup.mjs'

const lane = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-ui24')
assert.equal(process.cwd(), path.join(lane, 'repo'))
assert.equal(process.versions.node.split('.')[0], '22')
const project = 'pt4bafableol'
const container = `supabase_db_${project}`
const run = (name, args, input) => execFileSync(name, args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
const sql = input => run('docker', ['exec', '-i', container, 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], input)
const mode = process.argv[2]
mkdirSync(path.join(lane, 'evidence'), { recursive: true })
if (mode === 'setup' || mode === 'resume') {
    if (mode === 'setup') assert.equal(run('docker', ['ps', '-aq', '--filter', `label=com.supabase.cli.project=${project}`]).trim(), '')
    const original = run('git', ['show', 'HEAD:supabase/config.toml'])
    const config = original.replace(/^project_id = .*$/m, `project_id = "${project}"`).replace(/\b543(\d\d)\b/g, '638$1')
        .replace('inspector_port = 8083', 'inspector_port = 63883')
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
    const files = readdirSync('supabase/migrations').filter(file => /^\d{14}_.*\.sql$/.test(file)).sort()
    for (const file of files.filter(file => file.slice(0, 14) <= baseline)) cpSync(`supabase/migrations/${file}`, `${prefix}/supabase/migrations/${file}`)
    process.stdout.write('Applying backup schema baseline.\n')
    run('supabase', ['migration', 'up', '--local', '--include-all', '--workdir', prefix])
    sql(`CREATE SCHEMA IF NOT EXISTS offers_no_lock_lab;
    CREATE OR REPLACE FUNCTION offers_no_lock_lab.local_http_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.url !~ '^http://(127[.]0[.]0[.]1|localhost|host[.]lima[.]internal):638[0-9]{2}(/|$)' THEN RAISE EXCEPTION 'Private stack blocks external HTTP'; END IF;
      RETURN NEW; END; $$;
    DROP TRIGGER IF EXISTS offers_no_lock_lab_http ON net.http_request_queue;
    CREATE TRIGGER offers_no_lock_lab_http BEFORE INSERT OR UPDATE ON net.http_request_queue FOR EACH ROW EXECUTE FUNCTION offers_no_lock_lab.local_http_only();`)
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
    for (const file of files.filter(file => file.slice(0, 14) > baseline && file.slice(0, 14) < '20261214002900')) cpSync(`supabase/migrations/${file}`, `${prefix}/supabase/migrations/${file}`)
    process.stdout.write('Migrating backup to release 2.10.2.\n')
    run('supabase', ['migration', 'up', '--local', '--include-all', '--workdir', prefix])
    rmSync(prefix, { recursive: true })
    sql('SELECT cron.unschedule(jobid) FROM cron.job;')
    process.stdout.write(sql("SELECT jsonb_build_object('leagues',(SELECT count(*) FROM public.leagues),'players',(SELECT count(*) FROM public.players),'gameRows',(SELECT count(*) FROM public.player_game_stats),'rosters',(SELECT count(*) FROM public.roster_players));"))
} else if (mode === 'migrate') {
    writeFileSync('supabase/config.toml', readFileSync('supabase/config.toml', 'utf8').replace(/(\[db.migrations\][\s\S]*?enabled = )false/, '$1true'))
    run('supabase', ['migration', 'up', '--local', '--include-all'])
    sql('SELECT cron.unschedule(jobid) FROM cron.job;')
    process.stdout.write('Private candidate migration applied.\n')
} else if (['baseline', 'verify', 'attest'].includes(mode)) {
    const status = JSON.parse(run('supabase', ['status', '-o', 'json']))
    assert.equal(status.API_URL, 'http://127.0.0.1:63821')
    assert.equal(new URL(status.DB_URL).hostname, '127.0.0.1')
    assert.equal(new URL(status.DB_URL).port, '63822')
    const environment = { ...process.env, SUPABASE_DB_URL: status.DB_URL, PANCAKE_TEST_DB_PORT: '63822' }
    if (mode === 'attest') {
        process.stdout.write(execFileSync('node', ['scripts/regenerate-release-history-attestations.mjs'], { encoding: 'utf8', env: environment }))
    } else if (mode === 'baseline') {
        const result = spawnSync('psql', [status.DB_URL, '-X', '-v', 'ON_ERROR_STOP=1', '-f', 'tests/db/offers-do-not-lock.sql'], { encoding: 'utf8' })
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /Locked by trade/)
        writeFileSync(path.join(lane, 'evidence/baseline.log'), result.stdout + result.stderr)
        process.stdout.write('PASS: baseline rejects overlapping pending offers.\n')
    } else {
        const recipes = ['offers-do-not-lock', 'pending-asset-locks', 'trade-locks-drop-only', 'rules-faab-reservations',
            'trade-preview-read-only', 'trade-plan-moves-capacity', 'trade-roster-plans', 'server-trade-plan-acceptance',
            'rules-trade-submit-plans', 'rules-trade-reservation-message', 'release2-trade-accept-capacity',
            'trade-structured-legality', 'rules-trade-rejection-notifications', 'trade-identical-offers']
        const failures = []
        for (const name of recipes) {
            const result = spawnSync('psql', [status.DB_URL, '-X', '-v', 'ON_ERROR_STOP=1', '-f', `tests/db/${name}.sql`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
            writeFileSync(path.join(lane, `evidence/${name}.log`), result.stdout + result.stderr)
            if (result.status !== 0) failures.push(name)
            process.stdout.write(`${result.status === 0 ? 'PASS' : 'FAIL'}: ${name}\n`)
        }
        process.stdout.write(execFileSync('node', ['tests/e2e/offers-do-not-lock-concurrency.mjs'], { encoding: 'utf8', env: environment }))
        assert.deepEqual(failures, [], `Failed SQL recipes: ${failures.join(', ')}`)
    }
} else if (mode === 'stop') {
    run('supabase', ['stop', '--project-id', project, '--no-backup'])
    writeFileSync('supabase/config.toml', run('git', ['show', 'HEAD:supabase/config.toml']))
    if (existsSync(path.join(lane, 'backup'))) rmSync(path.join(lane, 'backup'), { recursive: true })
} else {
    throw new Error('Choose setup, resume, baseline, migrate, verify, attest, or stop')
}

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { chunkBackup } from '../db/l3e-chunk-backup.mjs'

const lane = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-ui25')
assert.equal(process.cwd(), path.join(lane, 'repo'))
assert.equal(process.versions.node.split('.')[0], '22')
const project = 'pt4bafabletc'
const container = `supabase_db_${project}`
const run = (name, args, input) => execFileSync(name, args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
const sql = input => run('docker', ['exec', '-i', container, 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], input)
const mode = process.argv[2]
mkdirSync(path.join(lane, 'evidence'), { recursive: true })
if (mode === 'setup' || mode === 'restore') {
    const prefix = path.join(lane, 'prefix')
    const baseline = JSON.parse(readFileSync('tests/e2e/db-security-catalog-attestations.json', 'utf8')).preMigration.version
    const files = readdirSync('supabase/migrations').filter(file => /^\d{14}_.*\.sql$/.test(file)).sort()
    if (mode === 'setup') {
    assert.equal(run('docker', ['ps', '-aq', '--filter', `label=com.supabase.cli.project=${project}`]).trim(), '')
    const original = run('git', ['show', 'HEAD:supabase/config.toml'])
    const config = original.replace(/^project_id = .*$/m, `project_id = "${project}"`).replace(/\b543(\d\d)\b/g, '639$1')
        .replace('inspector_port = 8083', 'inspector_port = 63983')
        .replace(/(\[db.migrations\][\s\S]*?enabled = )true/, '$1false')
        .replace(/(\[db.seed\][\s\S]*?enabled = )true/, '$1false')
    writeFileSync('supabase/config.toml', config)
    process.stdout.write('Starting private stack.\n')
    run('supabase', ['start', '-x', 'studio,imgproxy,vector,logflare,supavisor,edge-runtime,postgres-meta,mailpit'])
    sql("ALTER SYSTEM SET cron.launch_active_jobs='off'; ALTER SYSTEM SET maintenance_work_mem='32MB'; ALTER SYSTEM SET work_mem='4MB'; ALTER SYSTEM SET max_parallel_maintenance_workers=0; ALTER SYSTEM SET max_parallel_workers_per_gather=0; SELECT pg_reload_conf();")
    mkdirSync(path.join(prefix, 'supabase/migrations'), { recursive: true })
    writeFileSync(path.join(prefix, 'supabase/config.toml'), config.replace(/(\[db.migrations\][\s\S]*?enabled = )false/, '$1true'))
    for (const file of files.filter(file => file.slice(0, 14) <= baseline)) cpSync(`supabase/migrations/${file}`, `${prefix}/supabase/migrations/${file}`)
    process.stdout.write('Applying backup schema baseline.\n')
    run('supabase', ['migration', 'up', '--local', '--include-all', '--workdir', prefix])
    sql(`CREATE SCHEMA IF NOT EXISTS trade_curve_lab;
    CREATE FUNCTION trade_curve_lab.local_http_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.url !~ '^http://(127[.]0[.]0[.]1|localhost|host[.]lima[.]internal):639[0-9]{2}(/|$)' THEN RAISE EXCEPTION 'Private stack blocks external HTTP'; END IF;
      RETURN NEW; END; $$;
    CREATE TRIGGER trade_curve_lab_http BEFORE INSERT OR UPDATE ON net.http_request_queue FOR EACH ROW EXECUTE FUNCTION trade_curve_lab.local_http_only();`)
    }
    const source = readFileSync(path.join(lane, 'backup/data.sql'), 'utf8')
    const chunked = chunkBackup(source)
    const verified = chunkBackup(chunked.sql, Number.MAX_SAFE_INTEGER)
    assert.equal(chunked.valuesSha256, verified.valuesSha256)
    assert.equal(chunked.rows, verified.rows)
    const data = chunked.sql
    writeFileSync(path.join(lane, 'evidence/restore.json'), JSON.stringify({ rows: chunked.rows, statements: chunked.statements, valuesSha256: chunked.valuesSha256 }))
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
      UPDATE public.profiles SET push_token=NULL,push_token_revocation_hash=NULL;
      UPDATE auth.users SET encrypted_password='',confirmation_token='',recovery_token='',email_change_token_new='',email_change='',email_change_token_current='',reauthentication_token='';COMMIT;`)
    rmSync(path.join(lane, 'backup'), { recursive: true })
    for (const file of files.filter(file => file.slice(0, 14) > baseline)) cpSync(`supabase/migrations/${file}`, `${prefix}/supabase/migrations/${file}`)
    process.stdout.write('Migrating backup to the trade curve candidate.\n')
    run('supabase', ['migration', 'up', '--local', '--include-all', '--workdir', prefix])
    rmSync(prefix, { recursive: true })
    sql('SELECT cron.unschedule(jobid) FROM cron.job;')
} else if (mode === 'verify') {
    for (const file of ['trade-curve', 'trade-estimate-reanalysis', 'trade-historical-revaluation']) {
        const result = spawnSync('docker', ['exec', '-i', container, 'psql', '-X', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
            input: readFileSync(`tests/db/${file}.sql`, 'utf8').replace(/\\ir ([^\n]+)/g, (_, name) => readFileSync(path.resolve('tests/db', name), 'utf8')),
            encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        })
        writeFileSync(path.join(lane, 'evidence', `${file}.log`), result.stdout + result.stderr)
        assert.equal(result.status, 0, `${file}: ${result.stderr.slice(-3000)}`)
        process.stdout.write(`${file}: passed\n`)
    }
} else if (mode === 'prepare-web') {
    const status = JSON.parse(run('supabase', ['status', '-o', 'json']))
    assert.equal(status.API_URL, 'http://127.0.0.1:63921')
    assert.equal(new URL(status.DB_URL).hostname, '127.0.0.1')
    assert.equal(new URL(status.DB_URL).port, '63922')
    const environment = {
        EXPO_PUBLIC_SUPABASE_URL: status.API_URL,
        EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.ANON_KEY,
        EXPO_PUBLIC_API_URL: `${status.API_URL}/functions/v1/api`,
        SUPABASE_DB_URL: status.DB_URL,
        PANCAKE_TEST_DB_PORT: '63922',
        EXPO_NO_DOTENV: '1', EXPO_OFFLINE: '1', EXPO_NO_TELEMETRY: '1', CI: '1',
    }
    writeFileSync('.env', Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 })
    writeFileSync(path.join(lane, 'edge.env'), `PANCAKE_SUPABASE_SECRET_KEY=${status.SERVICE_ROLE_KEY}\nPANCAKE_EDGE_INTERNAL_TOKEN=trade-curve-local-only\n`, { mode: 0o600 })
    sql(`UPDATE auth.users account SET instance_id='00000000-0000-0000-0000-000000000000',
      email=member.id::text||'@example.test',encrypted_password=extensions.crypt('Trade-curve-local-only-2026',extensions.gen_salt('bf')),
      email_confirmed_at=now(),raw_app_meta_data='{"provider":"email","providers":["email"]}'
      FROM public.league_members member WHERE account.id=member.user_id AND member.league_id='faab8d8f-6a60-4bbc-8f5d-44050b652cdd';`)
    const member = JSON.parse(sql(`SELECT jsonb_build_object('memberId',member.id,'email',member.id::text||'@example.test','tradeId',target.id,'tab',CASE WHEN target.status='pending' THEN 'offers' ELSE 'history' END,'recipientMemberId',(SELECT id FROM public.league_members other WHERE other.league_id=league.id AND other.id<>member.id ORDER BY other.id LIMIT 1))
      FROM public.league_members member JOIN public.leagues league ON league.id=member.league_id
      JOIN public.trades target ON target.proposer_member_id=member.id
      WHERE league.id='faab8d8f-6a60-4bbc-8f5d-44050b652cdd' AND target.status IN('pending','accepted')
      ORDER BY (target.status='pending') DESC,target.proposed_at DESC LIMIT 1;`))
    writeFileSync(path.join(lane, 'browser-state.json'), JSON.stringify({ ...member, password: 'Trade-curve-local-only-2026' }))
    process.stdout.write('Building local web artifact.\n')
    execFileSync('npx', ['expo', 'export', '--platform', 'web', '--clear'], { encoding: 'utf8', env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] })
} else if (mode === 'stop') {
    run('supabase', ['stop', '--project-id', project, '--no-backup'])
    writeFileSync('supabase/config.toml', run('git', ['show', 'HEAD:supabase/config.toml']))
    if (existsSync(path.join(lane, 'backup'))) rmSync(path.join(lane, 'backup'), { recursive: true })
} else {
    throw new Error('Choose setup, verify, or stop')
}

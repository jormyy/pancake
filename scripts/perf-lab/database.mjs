import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { command } from './process.mjs'
import { localTarget, ports, project } from './common.mjs'

export function stackValues(output) {
  const values = Object.fromEntries(output.split('\n').flatMap(line => {
    const match = /^([A-Z_]+)="(.*)"$/.exec(line)
    return match ? [[match[1], match[2]]] : []
  }))
  localTarget(values.API_URL, [ports.api])
  const db = localTarget(values.DB_URL, [ports.db])
  assert.equal(db.pathname, '/postgres')
  assert.ok(values.ANON_KEY && values.SERVICE_ROLE_KEY, 'Local stack keys are missing')
  return values
}

export async function localKeys() {
  return stackValues((await command('supabase', ['status', '-o', 'env'])).stdout)
}

export async function sql(statement, { input = '', measured = false } = {}) {
  const result = await command('docker', ['exec', '-i', `supabase_db_${project}`, 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
    input: `${measured ? '' : "SET application_name = 'perf-lab-observer'; SET pg_stat_statements.track = 'none';\n"}${statement}\n${input ?? ''}`,
    timeout: 240000, label: 'local database operation; SQL output withheld',
  })
  return result.stdout.trim()
}

export function backupTables(text) {
  const tables = [...new Set([...text.matchAll(/^INSERT INTO ("[a-z_]+"\."[a-z_]+")\s*\(/gm)].map(match => match[1]))]
  assert.ok(tables.includes('"public"."players"') && tables.includes('"public"."leagues"'), 'Backup lacks production-shaped tables')
  assert.ok(!/^\\(?:i|include|!|connect|c|copy)\b/m.test(text), 'Backup contains an unexpected psql command')
  return tables
}

export async function restoreBackup(directory) {
  const [schema, data] = await Promise.all(['schema.sql', 'data.sql'].map(file => readFile(`${directory}/${file}`, 'utf8')))
  assert.ok(schema.includes('CREATE TABLE') && schema.includes('"public"."players"'), 'Backup schema is missing')
  const tables = backupTables(data)
  await sql(`ALTER TABLE storage.buckets
    ADD COLUMN IF NOT EXISTS versioning_status text NOT NULL DEFAULT 'DISABLED',
    ADD COLUMN IF NOT EXISTS lifecycle_configuration jsonb,
    ADD COLUMN IF NOT EXISTS lifecycle_configuration_generation uuid;
    ALTER TABLE storage.objects
    ADD COLUMN IF NOT EXISTS archived_at timestamptz,
    ADD COLUMN IF NOT EXISTS is_delete_marker boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS is_versioned boolean NOT NULL DEFAULT false;`)
  await sql(`BEGIN; SET LOCAL session_replication_role = replica; TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE;`, { input: `${data}\nSET LOCAL session_replication_role = replica;
    TRUNCATE auth.sessions, auth.refresh_tokens, auth.mfa_amr_claims, public.web_push_subscriptions, public.notification_outbox CASCADE;
    UPDATE public.profiles SET push_token = NULL, push_token_revocation_hash = NULL;
    UPDATE auth.users SET encrypted_password = '', confirmation_token = '', recovery_token = '', email_change_token_new = '', email_change = '', email_change_token_current = '', reauthentication_token = '';
    COMMIT;` })
  return { tables: tables.length, schemaBytes: Buffer.byteLength(schema), dataBytes: Buffer.byteLength(data), schemaPolicy: 'Restore at the recorded production schema baseline, then apply the remaining main migrations.', storageCompatibility: ['0062-object-versioning-core', '0068-bucket-lifecycle-configuration'] }
}

export const networkFenceSql = `
CREATE SCHEMA IF NOT EXISTS perf_lab;
CREATE OR REPLACE FUNCTION perf_lab.local_http_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.url !~ '^http://(127[.]0[.]0[.]1|localhost|host[.]lima[.]internal):(${ports.api}|${ports.edge})(/|$)' THEN
    RAISE EXCEPTION 'Lab blocks external HTTP';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS perf_lab_local_http ON net.http_request_queue;
CREATE TRIGGER perf_lab_local_http BEFORE INSERT OR UPDATE ON net.http_request_queue FOR EACH ROW EXECUTE FUNCTION perf_lab.local_http_only();
`;

export const captureSettingsSql = `
ALTER SYSTEM SET pg_stat_statements.track = 'all';
ALTER SYSTEM SET session_preload_libraries = 'auto_explain';
ALTER SYSTEM SET auto_explain.log_min_duration = '25';
ALTER SYSTEM SET auto_explain.sample_rate = '0.01';
ALTER SYSTEM SET auto_explain.log_analyze = 'on';
ALTER SYSTEM SET auto_explain.log_buffers = 'on';
ALTER SYSTEM SET auto_explain.log_timing = 'off';
ALTER SYSTEM SET auto_explain.log_nested_statements = 'on';
ALTER SYSTEM SET log_min_duration_statement = '-1';
ALTER SYSTEM SET log_parameter_max_length = '0';
ALTER SYSTEM SET log_parameter_max_length_on_error = '0';
ALTER SYSTEM SET log_line_prefix = '%m [%p] %a %u@%d ';
SELECT pg_reload_conf();
`;

export async function statementSnapshot() {
  return JSON.parse(await sql(`SELECT coalesce(json_agg(s),'[]') FROM (
    SELECT queryid::text, userid::text, dbid::text, toplevel, query, calls, rows, total_exec_time, shared_blks_hit, shared_blks_read,
      shared_blks_dirtied, shared_blks_written, temp_blks_read, temp_blks_written, wal_bytes::text
    FROM extensions.pg_stat_statements
    WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND query NOT LIKE '%pg_stat_statements%'
    ORDER BY total_exec_time DESC
  ) s;`))
}

export function statementDelta(before, after) {
  const key = row => `${row.queryid}/${row.userid}/${row.dbid}/${row.toplevel}`
  const old = new Map(before.map(row => [key(row), row]))
  return after.map(row => {
    const previous = old.get(key(row)) ?? {}
    const values = Object.fromEntries(['calls', 'rows', 'total_exec_time', 'shared_blks_hit', 'shared_blks_read', 'shared_blks_dirtied', 'shared_blks_written', 'temp_blks_read', 'temp_blks_written'].map(key => [key, Number(row[key] ?? 0) - Number(previous[key] ?? 0)]))
    assert.ok(Object.values(values).every(value => value >= -0.000001), 'Statement counters reset during capture')
    return { queryid: row.queryid, userid: row.userid, dbid: row.dbid, query: row.query, toplevel: row.toplevel, ...values }
  }).filter(row => row.calls > 0)
}

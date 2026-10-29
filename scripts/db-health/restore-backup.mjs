import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { connectionEnvironment } from './index.mjs'

export function backupInserts(source) {
  const matches = [...source.matchAll(/^INSERT INTO "([^"]+)"\."([^"]+)" \(([^\n]+)\) VALUES\n/gm)]
  return matches.flatMap((match, index) => {
    const [, schema, table, columns] = match
    if (!['public', 'private', 'analytics'].includes(schema) && !(schema === 'auth' && table === 'users')) return []
    const block = source.slice(match.index, matches[index + 1]?.index ?? source.length)
    const end = block.lastIndexOf(';\n')
    assert.ok(end >= 0, `Missing INSERT terminator for ${schema}.${table}`)
    return [{ schema, table, relation: `${schema}.${table}`, columns: [...columns.matchAll(/"([^"]+)"/g)].map(value => value[1]),
      statement: block.slice(0, end + 1) }]
  })
}

export function restoreBackup(url, file, proofFile) {
  const env = connectionEnvironment(url)
  assert.equal(env.PGUSER, 'supabase_admin', 'Restore requires the local database administrator')
  const run = input => execFileSync('psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1'],
    { input, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  const source = readFileSync(file, 'utf8')
  const metadata = JSON.parse(run(`SELECT jsonb_object_agg(relation,columns) FROM (
    SELECT table_schema||'.'||table_name relation,jsonb_agg(column_name) columns FROM information_schema.columns
    WHERE table_schema IN ('public','private','analytics','auth') GROUP BY table_schema,table_name) s;`))
  const omitted = new Set(['public.cron_dispatch_state', 'public.notif_event_catalog'])
  const inserts = backupInserts(source).filter(row => !omitted.has(row.relation))
  for (const row of inserts) {
    assert.ok(metadata[row.relation], `Missing table ${row.relation}`)
    assert.ok(row.columns.every(column => metadata[row.relation].includes(column)), `Missing columns for ${row.relation}`)
  }
  const referenceCounts = () => JSON.parse(run(`SELECT jsonb_build_object('workKinds',(SELECT count(*) FROM private.work_kinds),
    'retentionRules',(SELECT count(*) FROM private.retention_rules),'notificationKinds',(SELECT count(*) FROM public.notif_event_catalog));`))
  const before = referenceCounts()
  assert.ok(Object.values(before).every(count => Number(count) > 0), 'Migrations must seed reference tables before restoration')
  const relations = [...new Set(inserts.map(row => `"${row.schema}"."${row.table}"`))]
  run(`BEGIN;
    SET LOCAL session_replication_role=replica;
    SET LOCAL statement_timeout='0';
    TRUNCATE ${relations.join(',')} RESTART IDENTITY CASCADE;
    ${inserts.map(row => row.statement).join('\n')}
    DO $$ DECLARE r record; sequence_name text; max_id bigint; BEGIN
      FOR r IN SELECT table_schema,table_name,column_name FROM information_schema.columns
        WHERE table_schema IN ('public','private','analytics','auth') AND (column_default LIKE 'nextval%' OR is_identity='YES') LOOP
        sequence_name:=pg_get_serial_sequence(format('%I.%I',r.table_schema,r.table_name),r.column_name);
        IF sequence_name IS NOT NULL THEN
          EXECUTE format('SELECT max(%I) FROM %I.%I',r.column_name,r.table_schema,r.table_name) INTO max_id;
          IF max_id IS NOT NULL THEN PERFORM setval(sequence_name::regclass,max_id,true); END IF;
        END IF;
      END LOOP;
    END $$;
    DO $$ BEGIN
      IF jsonb_build_object('workKinds',(SELECT count(*) FROM private.work_kinds),
        'retentionRules',(SELECT count(*) FROM private.retention_rules),
        'notificationKinds',(SELECT count(*) FROM public.notif_event_catalog)) IS DISTINCT FROM '${JSON.stringify(before)}'::jsonb THEN
        RAISE EXCEPTION 'Restoration changes migration reference data';
      END IF;
    END $$;
    COMMIT;
    ANALYZE;`)
  const after = referenceCounts()
  assert.deepEqual(after, before, 'Restoration must preserve migration reference data')
  const report = { dataSha256: createHash('sha256').update(source).digest('hex'),
    restoredTables: relations.length, insertStatements: inserts.length, omitted: [...omitted], referenceCounts: after,
    dataset: JSON.parse(run(`SELECT jsonb_build_object('leagues',(SELECT count(*) FROM public.leagues),
      'members',(SELECT count(*) FROM public.league_members),'players',(SELECT count(*) FROM public.players),
      'stats',(SELECT count(*) FROM public.player_game_stats));`)) }
  writeFileSync(proofFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  return report
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    assert.equal(process.argv.length, 4, 'Use restore-backup.mjs DATA.sql PROOF.json')
    process.stdout.write(`${JSON.stringify(restoreBackup(process.env.SUPABASE_DB_URL, process.argv[2], process.argv[3]))}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof assert.AssertionError ? error.message : 'Backup restoration failed; no source rows are printed.'}\n`)
    process.exitCode = 1
  }
}

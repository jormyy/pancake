import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { scenarios } from './roster-actions-cases.mjs'

const lane = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-a2')
assert.equal(process.cwd(), path.join(lane, 'repo'))
assert.equal(process.versions.node.split('.')[0], '22')
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const mode = option('mode') ?? 'parity'
const label = option('label') ?? 'baseline'
const evidence = path.join(lane, 'evidence')
await mkdir(evidence, { recursive: true })
const literal = value => `'${value.replaceAll("'", "''")}'`
const run = input => execFileSync('docker', ['exec', '-i', ...(mode === 'tests' ? ['-e', 'PGPASSWORD=postgres'] : []), 'supabase_db_pt4bafablea2', 'psql', '-XqAt', ...(mode === 'tests' ? ['-h', '127.0.0.1', '-U', 'supabase_admin'] : ['-U', 'supabase_admin']), '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000 })
const support = await readFile('tests/db/rules-support.sql', 'utf8')
const fixtureSource = await readFile('tests/db/roster-actions-fixture.sql', 'utf8')
const projection = process.argv.includes('--worker-projection')
const historyFixture = option('history') === 'short' ? fixtureSource.replace('GROUP BY player_id ORDER BY games DESC,player_id LIMIT 36', 'GROUP BY player_id ORDER BY games ASC,player_id LIMIT 36') : fixtureSource
let fixture = projection ? historyFixture.replace('DECLARE rows int;', 'DECLARE payload jsonb; rows int;').replace(
  'SELECT count(*),count(*) FILTER(WHERE processed) INTO rows,successes FROM public.process_due_waiver_claims_atomic(current_date+1,100);',
  `SELECT coalesce(jsonb_agg(CASE WHEN current_setting('roster_actions.variant')='candidate'
    THEN jsonb_build_object('processed',batch.processed) ELSE to_jsonb(batch) END),'[]') INTO payload
    FROM public.process_due_waiver_claims_atomic(current_date+1,100) batch;
  SELECT count(*),count(*) FILTER(WHERE (value->>'processed')::boolean) INTO rows,successes FROM jsonb_array_elements(payload);`,
) : historyFixture
if (projection) {
  assert.ok(['parity', 'measure'].includes(mode))
  fixture = fixture.replace('  LOOP\n    SELECT coalesce(jsonb_agg', `  PERFORM public.start_edge_invocation((SELECT invocation_key FROM ra_worker_context),'process-waivers');
  PERFORM public.renew_work_lease((SELECT invocation_key FROM ra_worker_context));
  PERFORM set_config('request.headers',(current_setting('request.headers')::jsonb || jsonb_build_object('x-pancake-work-key',(SELECT invocation_key FROM ra_worker_context)))::text,true);
  LOOP
    SELECT coalesce(jsonb_agg`).replace("  RETURN jsonb_build_object('ok',true,'processed',total);", `  PERFORM set_config('request.headers',(current_setting('request.headers')::jsonb - 'x-pancake-work-key')::text,true);
  PERFORM public.finish_edge_invocation((SELECT invocation_key FROM ra_worker_context),'success');
  RETURN jsonb_build_object('ok',true,'processed',total);`)
  fixture += `CREATE TEMP TABLE ra_worker_context AS WITH work AS (
    INSERT INTO private.work_items(kind,key,payload,status,lease_token,lease_until,invocation_key,attempts)
    VALUES('process-waivers',gen_random_uuid()::text,jsonb_build_object('roster_actions',gen_random_uuid()),'running',gen_random_uuid(),now()+interval '5 minutes',gen_random_uuid(),1)
    RETURNING id,lease_token,invocation_key) SELECT * FROM work;
  GRANT SELECT ON ra_worker_context TO authenticated,service_role;
  INSERT INTO public.edge_invocations(function_name,invocation_key,work_item_id,work_lease_token)
  SELECT 'process-waivers',invocation_key,id,lease_token FROM ra_worker_context;`
}
const files = (option('files') ?? '').split(',').filter(Boolean)
const baseline = files.map(file => execFileSync('git', ['show', `952580ce:supabase/sql/functions/by-name/${file}`], { encoding: 'utf8' })).join('\n')
const candidate = option('candidate') ? await readFile(option('candidate'), 'utf8') : (await Promise.all(files.map(file => readFile(`supabase/sql/functions/by-name/${file}`, 'utf8')))).join('\n')
const rows = [1, 2, 3].flatMap(scenarios).filter(row => !option('manager') || option('manager').split(',').includes(String(row.manager))).filter(row => !option('case') || option('case').split(',').some(name => row.name.includes(name)))
const action = row => `SELECT ${row.response === 'void' ? `(${row.expression})::text` : `to_jsonb(${row.expression})::text`}`
const setup = row => `${support}\n${mode === 'measure' ? fixture.replace(/SET LOCAL roster_actions.uuid='0';[\s\S]*?(?=CREATE TEMP TABLE ra_fixture)/, '') : fixture}\nSELECT set_config('request.jwt.claim.sub',${row.user}::text,true);\n${row.setup}\nSET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;`
const execute = row => `SET LOCAL ROLE ${row.role};SELECT pg_temp.ra_action(${literal(action(row))});RESET ROLE;SET CONSTRAINTS ALL IMMEDIATE;SET CONSTRAINTS ALL DEFERRED;`
const result = row => `SELECT jsonb_build_object('response',current_setting('roster_actions.response',true),'state',pg_temp.ra_diff());`
const observer = `CREATE TEMP TABLE ra_sequences(name text,value bigint,called boolean);
DO $$ DECLARE s record; v bigint; b boolean; BEGIN FOR s IN SELECT schemaname,sequencename FROM pg_sequences LOOP
  EXECUTE format('SELECT last_value,is_called FROM %I.%I',s.schemaname,s.sequencename) INTO v,b;
  INSERT INTO ra_sequences VALUES(format('%I.%I',s.schemaname,s.sequencename),v,b); END LOOP; END; $$;
CREATE FUNCTION pg_temp.ra_reset_sequences() RETURNS void LANGUAGE plpgsql AS $$ DECLARE s record; BEGIN FOR s IN SELECT * FROM ra_sequences LOOP PERFORM setval(s.name::regclass,s.value,s.called); END LOOP; END; $$;
CREATE TEMP TABLE ra_changes(relation text,image jsonb,sign int);
CREATE FUNCTION pg_temp.ra_observe() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
  IF TG_OP<>'INSERT' THEN INSERT INTO ra_changes VALUES(TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME,to_jsonb(OLD),-1); END IF;
  IF TG_OP<>'DELETE' THEN INSERT INTO ra_changes VALUES(TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME,to_jsonb(NEW),1); END IF;
  RETURN NULL;
END; $$;
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN('public','private','net','auth','realtime','storage') AND c.relkind IN('r','p') AND NOT c.relispartition LOOP
    EXECUTE format('CREATE TRIGGER ra_observe AFTER INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION pg_temp.ra_observe()',t.nspname,t.relname);
  END LOOP;
END; $$;
CREATE FUNCTION pg_temp.ra_diff() RETURNS jsonb LANGUAGE sql AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY relation,image,sign),'[]') FROM
    (SELECT relation,image,sum(sign) AS sign FROM ra_changes GROUP BY relation,image HAVING sum(sign)<>0) d;
$$;`
const request = row => `SELECT set_config('request.jwt.claim.role',${literal(row.role)},true),set_config('request.headers',jsonb_build_object('authorization','Bearer local-fixture','x-request-id',md5('ra-${row.name}-${row.manager}'))::text,true)\n\\g /dev/null\n`
const capture = (row, variant = 'baseline') => `SET LOCAL roster_actions.variant='${variant}';SET LOCAL ROLE ${row.role};SELECT set_config('roster_actions.response',pg_temp.ra_action(${literal(action(row))}),true)\n\\g /dev/null\nRESET ROLE;SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;`
function verify(row, response) {
  if (row.outcome === 'success') assert.ok(!/^[A-Z0-9]{5}:/.test(response), `${row.name}/${row.manager}: ${response}`)
  else assert.ok(response.toLowerCase().includes(row.outcome.toLowerCase()), `${row.name}/${row.manager}: expected ${row.outcome}, received ${response}`)
}
const reports = []
if (mode === 'parity') {
  for (const row of rows) {
    const output = run(`BEGIN;${setup(row)}\n${observer}\n${request(row)}SAVEPOINT variant;${baseline}${capture(row)}${result(row)}\nROLLBACK TO variant;SELECT pg_temp.ra_reset_sequences()\n\\g /dev/null\n${candidate}${capture(row, 'candidate')}${result(row)}\n${row === rows[0] ? `SAVEPOINT negative;UPDATE public.roster_players SET acquired_at=acquired_at+interval '1 second' WHERE id=md5('ra-roster-${row.manager}-2')::uuid;${result(row)}ROLLBACK TO negative;SELECT set_config('roster_actions.response',current_setting('roster_actions.response')||' ',true)\n\\g /dev/null\n${result(row)}` : ''}\nROLLBACK;`)
    const [before, after, rowControl, responseControl] = output.trim().split('\n').filter(line => line.startsWith('{')).map(JSON.parse)
    assert.ok(before && after, output.slice(-2000))
    verify(row, before.response)
    verify(row, after.response)
    assert.deepEqual(after, before, `${row.name}/${row.manager}`)
    if (rowControl) assert.throws(() => assert.deepEqual(rowControl, before))
    if (responseControl) assert.throws(() => assert.deepEqual(responseControl, before))
    assert.throws(() => assert.deepEqual({ ...after, response: `${after.response} ` }, before))
    const corrupted = structuredClone(after)
    corrupted.state.push({ relation: 'public.roster_players', image: { corrupted: true }, sign: 1 })
    assert.throws(() => assert.deepEqual(corrupted, before))
    reports.push({ name: row.name, manager: row.manager, workerProjection: projection, passed: true, negativeResponse: true, negativeRow: true, tables: [...new Set(after.state.map(change => change.relation))], followup: after.state.filter(change => /league_version|league_change|refresh|work_items|notification_outbox|league_events/.test(change.relation)).map(change => ({ table: change.relation, sign: change.sign, operation: change.image.operation ?? null, kind: change.image.work_kind ?? change.image.event_type ?? null })), responseBytes: Buffer.byteLength(after.response) })
    console.log(`PASS ${row.name}/${row.manager}: ${reports.at(-1).tables.length} tables`)
    await writeFile(path.join(evidence, `${label}-parity.json`), JSON.stringify(reports, null, 2))
  }
} else if (mode === 'measure') {
  const functions = `SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'name',p.proname,'trigger',p.prorettype='trigger'::regtype,'calls',s.calls-coalesce(b.calls,0),'totalMs',s.total_time-coalesce(b.total_time,0),'selfMs',s.self_time-coalesce(b.self_time,0))) FROM pg_stat_xact_user_functions s LEFT JOIN ra_fnbase b ON b.funcid=s.funcid JOIN pg_proc p ON p.oid=s.funcid JOIN pg_namespace n ON n.oid=p.pronamespace`
  const stats = phase => `SET LOCAL pg_stat_statements.track='none';SELECT jsonb_build_object('phase','${phase}','response',current_setting('roster_actions.response',true),'statements',(SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') FROM (SELECT query,toplevel,calls,total_plan_time,total_exec_time,shared_blks_hit,shared_blks_read,rows,wal_bytes FROM extensions.pg_stat_statements WHERE query NOT LIKE '%pg_stat_statements%') s),'functions',(${functions}),'writes',(SELECT coalesce(sum(n_tup_ins+n_tup_upd+n_tup_del),0) FROM pg_stat_xact_user_tables WHERE schemaname IN('public','private','net','auth','realtime','storage'))-(SELECT writes FROM ra_writebase));`
  const measured = row => `SET LOCAL pg_stat_statements.track='none';SELECT extensions.pg_stat_statements_reset()\n\\g /dev/null\nSET LOCAL pg_stat_statements.track='all';SET LOCAL ROLE ${row.role};
EXPLAIN(ANALYZE,BUFFERS,WAL,TIMING OFF,FORMAT JSON) SELECT set_config('roster_actions.response',pg_temp.ra_action(${literal(action(row))}),true);
RESET ROLE;SET CONSTRAINTS ALL IMMEDIATE;SET CONSTRAINTS ALL DEFERRED;`
  const rounds = Number(option('rounds') ?? 5)
  const journal = path.join(evidence, `${label}-samples.jsonl`)
  if (process.argv.includes('--resume')) {
    const saved = (await readFile(journal, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    const counts = new Map()
    for (const sample of saved) {
      const key = `${sample.name}/${sample.manager}/${sample.round}`
      const entries = counts.get(key) ?? new Set()
      entries.add(`${sample.variant}/${sample.phase}`)
      counts.set(key, entries)
    }
    reports.push(...saved.filter(sample => counts.get(`${sample.name}/${sample.manager}/${sample.round}`).size === 4))
  }
  const completed = new Set(reports.map(sample => `${sample.name}/${sample.manager}/${sample.round}`))
  await writeFile(journal, reports.map(sample => JSON.stringify(sample)).join('\n') + (reports.length ? '\n' : ''))
  for (let round = 0; round < rounds; round++) {
    for (const row of rows) for (const variant of ['baseline', 'candidate']) {
      if (completed.has(`${row.name}/${row.manager}/${round}`)) continue
      const output = run(`BEGIN;SET LOCAL roster_actions.variant='${variant}';SET LOCAL track_functions='all';SET LOCAL pg_stat_statements.track_planning=on;${variant === 'baseline' ? baseline : candidate}${setup(row)}
CREATE OR REPLACE FUNCTION pg_temp.ra_action(command text) RETURNS text LANGUAGE plpgsql AS $$ DECLARE response text; BEGIN EXECUTE command INTO response;SET CONSTRAINTS ALL IMMEDIATE;SET CONSTRAINTS ALL DEFERRED;RETURN coalesce(response,'');EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE||':'||SQLERRM;END; $$;
CREATE TEMP TABLE ra_writebase AS SELECT coalesce(sum(n_tup_ins+n_tup_upd+n_tup_del),0) AS writes FROM pg_stat_xact_user_tables WHERE schemaname IN('public','private','net','auth','realtime','storage');CREATE TEMP TABLE ra_fnbase AS SELECT * FROM pg_stat_xact_user_functions;${request(row)}SAVEPOINT sample;${measured(row)}${stats('fresh')}ROLLBACK TO sample;
${execute(row)}ROLLBACK TO sample;${execute(row)}ROLLBACK TO sample;
UPDATE ra_writebase SET writes=(SELECT coalesce(sum(n_tup_ins+n_tup_upd+n_tup_del),0) FROM pg_stat_xact_user_tables WHERE schemaname IN('public','private','net','auth','realtime','storage'));DELETE FROM ra_fnbase;INSERT INTO ra_fnbase SELECT * FROM pg_stat_xact_user_functions;${measured(row)}${stats('warm')}ROLLBACK;`)
      const values = jsonValues(output)
      const plans = values.filter(value => Array.isArray(value) && value[0]?.Plan).map(value => value[0])
      const snapshots = values.filter(value => value?.phase)
      assert.equal(plans.length, 2)
      assert.equal(snapshots.length, 2)
      for (let index = 0; index < 2; index++) {
        const snapshot = snapshots[index]
        verify(row, snapshot.response)
        const plan = plans[index]
        reports.push({ name: row.name, manager: row.manager, round, variant, phase: snapshot.phase, ms: plan['Planning Time'] + plan['Execution Time'], hits: plan.Plan['Shared Hit Blocks'] ?? 0, reads: plan.Plan['Shared Read Blocks'] ?? 0, wal: plan.Plan['WAL Bytes'] ?? 0, responseBytes: Buffer.byteLength(snapshot.response), plan, ...snapshot })
      }
      await appendFile(journal, reports.slice(-2).map(report => JSON.stringify(report)).join('\n') + '\n')
      console.log(`${round + 1} ${row.name}/${row.manager} ${variant}: ${reports.at(-2).ms.toFixed(3)} / ${reports.at(-1).ms.toFixed(3)} ms`)
    }
  }
  await writeFile(path.join(evidence, `${label}-samples.json`), JSON.stringify(reports))
} else if (mode === 'tests') {
  if (files.length) run(candidate)
  try {
  for (const name of (option('tests') ?? '').split(',').filter(Boolean)) {
    let input = (await includeSql(`tests/db/${name}.sql`)).replace(/BEGIN;/, name.startsWith('idempotency-') ? 'BEGIN;' : `BEGIN;SET LOCAL session_replication_role=replica;UPDATE public.waiver_claims SET process_date=current_date+100 WHERE status='pending';SET LOCAL session_replication_role=origin;`)
    if (name.startsWith('idempotency-')) input = input.replace('COMMIT;', () => 'GRANT USAGE ON SCHEMA idempotency_test TO postgres;GRANT INSERT,SELECT ON idempotency_test.applications TO postgres;COMMIT;')
    if (name.startsWith('idempotency-')) run(await readFile('tests/db/roster-actions-clean-idempotency.sql', 'utf8'))
    try { run(input) } finally { if (name.startsWith('idempotency-')) run(await readFile('tests/db/roster-actions-clean-idempotency.sql', 'utf8')) }
    reports.push({ name, passed: true })
    console.log(`PASS ${name}`)
  }
  await writeFile(path.join(evidence, `${label}-tests.json`), JSON.stringify(reports, null, 2))
  } finally { if (files.length) run(baseline) }
} else throw new Error(`Unknown mode: ${mode}`)

function jsonValues(source) {
  const values = []
  let start = -1
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (start < 0) { if (char === '[' || char === '{') { start = index; depth = 1 } continue }
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false }
    else if (char === '"') quoted = true
    else if (char === '[' || char === '{') depth++
    else if ((char === ']' || char === '}') && --depth === 0) { values.push(JSON.parse(source.slice(start, index + 1))); start = -1 }
  }
  return values
}

async function includeSql(file) {
  let sql = await readFile(file, 'utf8')
  for (const match of [...sql.matchAll(/^\\ir ([^\n]+)$/gm)]) {
    const included = await includeSql(path.resolve(path.dirname(file), match[1]))
    sql = sql.replace(match[0], () => included)
  }
  return sql
}

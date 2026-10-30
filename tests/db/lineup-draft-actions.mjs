import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { persistentFixture } from './lineup-draft-state.mjs'

const lane = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-a3')
assert.equal(process.cwd(), path.join(lane, 'repo'))
const mode = process.argv[2] ?? 'profile'
const files = process.argv.slice(3)
const connectionMode = process.env.ACTION_CONNECTION ?? 'warm'
const started = Date.now()
const phase = process.env.ACTION_PHASE ?? 'before'
const directory = path.join(lane, 'evidence')
mkdirSync(directory, { recursive: true })
const run = (name, args, input) => execFileSync(name, args, { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
const sql = source => {
  const result = spawnSync('psql', ['postgresql://supabase_admin:postgres@127.0.0.1:64522/postgres', '-XqAt', '-v', 'ON_ERROR_STOP=1'], { input: source, encoding: 'utf8', maxBuffer: 256*1024*1024, timeout: 120000 })
  if (result.status !== 0) throw new Error(result.stderr.slice(-4000))
  return result.stdout
}
const resourceCheck=()=>{
  process.env.DOCKER_HOST=`unix://${homedir()}/pancake-t_4ba51e0d/lima/pancake-dev/sock/docker.sock`
  const value=JSON.parse(run('docker',['inspect','--format','{{json .HostConfig}}','supabase_db_pt4bafablea3']))
  assert.equal(value.NanoCpus,2_000_000_000)
  assert.equal(value.Memory,1_073_741_824)
}
resourceCheck()
const quote = value => "'" + value.replaceAll("'", "''") + "'"
const fixture = readFileSync('tests/db/lineup-draft-fixture.sql', 'utf8').replace('\\ir rules-support.sql', () => readFileSync('tests/db/rules-support.sql', 'utf8'))
const frozen = readFileSync('tests/db/lineup-draft-freeze.sql', 'utf8')
const deferred = JSON.parse(sql("SELECT jsonb_agg(format('%I.%I',n.nspname,c.conname) ORDER BY n.nspname,c.conname) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE c.condeferrable AND c.condeferred;")).join(', ')
const capture = `
CREATE FUNCTION pg_temp.action_flush() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
SET CONSTRAINTS ${deferred} IMMEDIATE;
SET CONSTRAINTS ${deferred} DEFERRED;
END; $$;
CREATE FUNCTION pg_temp.action_capture(command text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE response text;
BEGIN
EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(r)),''[]'')::text FROM ('||rtrim(command,';')||')r' INTO response;
PERFORM pg_temp.action_flush();
RETURN response;
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('error',SQLSTATE,'message',SQLERRM)::text;
END; $$;
`
const definitions = Object.fromEntries(files.map(file => [file, {
  before: run('git', ['show', `952580ce:${file}`]),
  after: readFileSync(file, 'utf8'),
}]))
const replacements = variant => Object.values(definitions).map(definition => definition[variant]).join('\n')
const checks = JSON.parse(sql("SELECT jsonb_build_object('buffers',current_setting('shared_buffers'),'cache',current_setting('effective_cache_size'),'cron',current_setting('cron.launch_active_jobs'));"))
assert.deepEqual(checks, { buffers: '224MB', cache: '384MB', cron: 'off' })
const anchor = new Date().toISOString()
let prelude = `BEGIN; ALTER EVENT TRIGGER pgrst_ddl_watch DISABLE; ALTER EVENT TRIGGER pgrst_drop_watch DISABLE; SET LOCAL track_functions='all'; SET LOCAL pg_stat_statements.track='all'; ${frozen} CREATE OR REPLACE FUNCTION pg_catalog.now() RETURNS timestamptz LANGUAGE sql STABLE AS $freeze$ SELECT ${quote(anchor)}::timestamptz $freeze$; ${fixture}\n${capture} SELECT pg_temp.action_flush();`
const audit = `DO $$ DECLARE t record; BEGIN FOR t IN
SELECT c.oid::regclass AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname IN ('public','private','auth','net') AND c.relkind IN ('r','p') AND NOT c.relispartition
LOOP EXECUTE format('CREATE TRIGGER action_audit AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION pg_temp.action_audit()',t.name); END LOOP; END; $$;`
const sequences = `CREATE TEMP TABLE action_sequences AS SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname IN ('public','private','net','auth');`
const reset = `DO $$ DECLARE s record; BEGIN FOR s IN SELECT * FROM action_sequences WHERE last_value IS NOT NULL LOOP PERFORM setval(format('%I.%I',s.schemaname,s.sequencename)::regclass,s.last_value,true); END LOOP; END; $$; SELECT setval('pg_temp.action_ids',100000,false);`
const request = row => /^(optimizer-|pre-tipoff-|close-)/.test(row.name) ? "SELECT set_config('request.headers','{}',true);" : `SELECT set_config('request.headers',jsonb_build_object('x-request-id',md5(${quote('action:'+row.name+':'+row.manager)}),'x-request-actor',auth.uid())::text,true);`
const invoke = row => `SELECT set_config('action.response',pg_temp.action_capture(${quote(row.command)}),true);`
let persistent
try {
    if(['bench','quality'].includes(mode)) {
      persistent=persistentFixture({sql,fixture,anchor,directory,performance:mode==='bench'})
      prelude=`BEGIN; SET LOCAL track_functions='all'; SET LOCAL pg_stat_statements.track='all'; ${frozen} ${capture}`
    }
    const allCases=persistent?.cases??JSON.parse(sql(`${prelude} SELECT jsonb_agg(to_jsonb(c) ORDER BY name,manager) FROM action_cases c; ROLLBACK;`).trim().split('\n').at(-1))
    const cases=allCases.filter(row=>!process.env.ACTION_CASE||new RegExp(process.env.ACTION_CASE).test(row.name))
    if (mode === 'locks') {
      const original=run('git',['show','952580ce:supabase/sql/functions/by-name/private/lineup_game_started.sql']).replace('FUNCTION private.lineup_game_started(', 'FUNCTION pg_temp.baseline_game_started(')
      const source=`${prelude}${original}${replacements('after')}
INSERT INTO private.player_game_memberships(player_id,game_id) SELECT p.id,g.id FROM action_players p CROSS JOIN public.nba_games g WHERE p.n=1 AND g.nba_game_id='action-earlier-game' ON CONFLICT DO NOTHING;
CREATE TEMP TABLE action_lock_dates AS SELECT p.id,d.game_date FROM action_players p CROSS JOIN LATERAL(
SELECT actual.game_date FROM public.player_game_stats stats JOIN public.nba_games actual ON actual.id=stats.game_id WHERE stats.player_id=p.id ORDER BY actual.game_date DESC LIMIT 5)d
UNION SELECT p.id,(now() AT TIME ZONE 'America/New_York')::date+day_offset FROM action_players p CROSS JOIN unnest(ARRAY[-1,0,1,8])day_offset;
SELECT jsonb_build_object('comparisons',count(*),'mismatches',count(*) FILTER(WHERE pg_temp.baseline_game_started(id,game_date) IS DISTINCT FROM private.lineup_game_started(id,game_date))) FROM action_lock_dates;
ROLLBACK;`
      const report=JSON.parse(sql(source).trim().split('\n').at(-1))
      assert.equal(report.mismatches,0)
      writeFileSync(path.join(directory,'lock-parity.json'),JSON.stringify(report))
      process.stdout.write(JSON.stringify(report)+'\n')
    } else if (mode === 'profile') {
      const trace = `${prelude}${replacements(phase)}
LOAD 'auto_explain'; SET LOCAL auto_explain.log_min_duration=0; SET LOCAL auto_explain.log_nested_statements=on;
SET LOCAL auto_explain.log_analyze=on; SET LOCAL auto_explain.log_buffers=on; SET LOCAL auto_explain.log_wal=on;
SET LOCAL auto_explain.log_triggers=on; SET LOCAL auto_explain.log_format=json; SET LOCAL client_min_messages=log;
${cases.filter(row => row.manager === 1).map(row => `SAVEPOINT action; ${row.prepare} ${request(row)} SELECT pg_temp.action_flush(); SELECT ${quote(row.name)}; ${invoke(row)} ROLLBACK TO action;`).join('\n')}
ROLLBACK;`
      const result = spawnSync('psql', ['postgresql://supabase_admin:postgres@127.0.0.1:64522/postgres', '-XqAt', '-v', 'ON_ERROR_STOP=1'], { input: trace, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
      writeFileSync(path.join(directory, `${phase}-profile.log`), result.stderr)
      writeFileSync(path.join(directory, `${phase}-responses.log`), result.stdout)
      assert.equal(result.status, 0, result.stderr.slice(-3000))
      process.stdout.write(result.stdout)
    } else if (mode === 'quality') {
      const fingerprint=createHash('sha256').update(JSON.stringify({definitions,fixture,frozen,capture,audit,persistent:true})).digest('hex')
      const evidenceFile=path.join(directory,'quality.json')
      const values=[]
      if(process.env.ACTION_QUALITY_RESUME==='1') {
        const previous=JSON.parse(readFileSync(evidenceFile,'utf8'))
        assert.equal(previous.fingerprint,fingerprint)
        values.push(...previous.rows)
      }
      const save=complete=>writeFileSync(evidenceFile,JSON.stringify({fingerprint,complete,comparisons:values.length,negativeControls:values.length*2,rows:values},null,2))
      for(const row of cases) {
        if(values.some(value=>value.name===row.name&&value.manager===row.manager)) continue
        const source=`${prelude}${audit}${sequences}
${['before','after'].map(variant => `SAVEPOINT action; ${replacements(variant)} ${reset} ${row.prepare} ${request(row)} SELECT pg_temp.action_flush();
TRUNCATE action_writes; ${invoke(row)}
CREATE TEMP TABLE action_result AS SELECT ${quote(row.name)} AS name,${row.manager} AS manager,${quote(variant)} AS variant,current_setting('action.response') AS response,pg_temp.action_snapshot() AS state,(SELECT jsonb_object_agg(table_name,n) FROM (SELECT table_name,count(*) n FROM action_writes GROUP BY table_name)s) AS writes;
SELECT to_jsonb(r) FROM action_result r;
ROLLBACK TO action;`).join('\n')}
ROLLBACK;`
        const pair=sql(source).trim().split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line)).filter(value=>value.variant&&value.name)
        const [before,after]=pair
        assert.equal(pair.length,2)
        assert.equal(after.response,before.response,`${row.name}/${row.manager} response`)
        assert.ok(isDeepStrictEqual(after.state,before.state),`${row.name}/${row.manager} complete row state differs: ${Object.keys(before.state).filter(table=>!isDeepStrictEqual(after.state[table],before.state[table])).join(', ')}`)
        const changed=structuredClone(after)
        changed.response+='x'
        assert.throws(()=>assert.equal(changed.response,before.response))
        changed.state.mutation=[{altered:true}]
        assert.throws(()=>assert.deepEqual(changed.state,before.state))
        assert.equal(before.response.includes('"error"')||/"error_(code|message)"\s*:\s*"/.test(before.response),row.name.startsWith('denied-'),`${row.name}/${row.manager}: ${before.response}`)
        values.push({name:row.name,manager:row.manager,response:before.response,writes:before.writes,hashes:Object.fromEntries(Object.entries(before.state).map(([table,rows])=>[table,createHash('sha256').update(JSON.stringify(rows)).digest('hex')]))})
        resourceCheck()
        save(false)
      }
      save(true)
      process.stdout.write(`PASS: ${values.length} byte response and whole-table comparisons; ${values.length*2} rejected mutations\n`)
    } else if (mode === 'bench') {
      const samples = []
      const evidenceFile=path.join(directory,`benchmark-${connectionMode}.json`)
      const fingerprint=createHash('sha256').update(JSON.stringify({definitions,fixture,frozen,capture,persistent:true,counters:'per-query-reset-v1'})).digest('hex')
      if(process.env.ACTION_RESUME==='1') {
        const previous=JSON.parse(readFileSync(evidenceFile,'utf8'))
        assert.equal(previous.fingerprint,fingerprint,'Resume requires identical action sources and fixture')
        samples.push(...previous.samples)
      }
      const save=complete=>writeFileSync(evidenceFile,JSON.stringify({checks,files,fingerprint,complete,counters:'per-query-reset-v1',samples},null,2))
      const pairTarget=Number(process.env.ACTION_PAIRS??5)
      assert.ok(Number.isInteger(pairTarget)&&pairTarget>=5&&pairTarget<=15)
      const repeatsFor=row=>{const managers=cases.filter(value=>value.name===row.name).map(value=>value.manager);return Math.floor(pairTarget/managers.length)+(managers.indexOf(row.manager)<pairTarget%managers.length?1:0)}
      const completed=row=>samples.filter(sample=>sample.name===row.name&&sample.manager===row.manager).length>=repeatsFor(row)*2
      const measure = (rows, repeats, connection, selectedVariants, outerRound = 0) => {
        assert.ok(Date.now()-started < 18*60*1000, 'Timing round exceeded eighteen minutes')
        const commands = []
        for (let round = 0; round < repeats; round++) {
          for (const row of rows) {
            const variants = selectedVariants ?? ['before','after']
            for (const variant of variants) commands.push(`${replacements(variant)}
${connection === 'warm' ? `SAVEPOINT prewarm; ${reset} ${row.prepare} ${request(row)} ${invoke(row)} ROLLBACK TO prewarm;` : ''}
SAVEPOINT action; ${reset} ${row.prepare} ${request(row)} SELECT pg_temp.action_flush();
CREATE TEMP TABLE action_counts AS SELECT relid,n_tup_ins,n_tup_upd,n_tup_del FROM pg_stat_xact_user_tables WHERE schemaname IN ('public','private','auth','net');
CREATE TEMP TABLE action_function_counts AS SELECT funcid,calls,total_time,self_time FROM pg_stat_xact_user_functions;
SELECT extensions.pg_stat_statements_reset();
CREATE TEMP TABLE action_statement_count AS SELECT userid,dbid,queryid,toplevel,calls FROM extensions.pg_stat_statements WHERE query NOT LIKE '%pg_stat_statements%';
DO $measure$ DECLARE plan json; writes jsonb; functions jsonb; statements bigint; BEGIN
EXECUTE ${quote("EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) SELECT set_config('action.response',pg_temp.action_capture(" + quote(row.command) + '),true)')} INTO plan;
SELECT coalesce(jsonb_object_agg(table_name,counts),'{}') INTO writes FROM (
SELECT s.schemaname||'.'||s.relname AS table_name,jsonb_build_object('insert',s.n_tup_ins-c.n_tup_ins,'update',s.n_tup_upd-c.n_tup_upd,'delete',s.n_tup_del-c.n_tup_del) AS counts
FROM pg_stat_xact_user_tables s JOIN action_counts c USING(relid) WHERE (s.n_tup_ins,s.n_tup_upd,s.n_tup_del) IS DISTINCT FROM (c.n_tup_ins,c.n_tup_upd,c.n_tup_del))w;
SELECT coalesce(jsonb_object_agg(s.schemaname||'.'||s.funcname,jsonb_build_object('calls',s.calls-coalesce(c.calls,0),'totalMs',s.total_time-coalesce(c.total_time,0),'selfMs',s.self_time-coalesce(c.self_time,0),'trigger',p.prorettype='trigger'::regtype)),'{}') INTO functions FROM pg_stat_xact_user_functions s LEFT JOIN action_function_counts c USING(funcid) JOIN pg_proc p ON p.oid=s.funcid WHERE s.calls>coalesce(c.calls,0);
SELECT coalesce(sum(greatest(s.calls-coalesce(c.calls,0),0)),0) INTO statements FROM extensions.pg_stat_statements s LEFT JOIN action_statement_count c USING(userid,dbid,queryid,toplevel) WHERE s.query NOT LIKE '%pg_stat_statements%';
RAISE NOTICE 'SAMPLE %',jsonb_build_object('name',${quote(row.name)},'manager',${row.manager},'variant',${quote(variant)},'round',${round+outerRound},'connection',${quote(connection)},'plan',plan,'writes',writes,'functions',functions,'statements',statements,'response',current_setting('action.response'));
END; $measure$;
ROLLBACK TO action;`)
          }
        }
        const result = spawnSync('psql',['postgresql://supabase_admin:postgres@127.0.0.1:64522/postgres','-XqAt','-v','ON_ERROR_STOP=1'],{ input:prelude+sequences+commands.join('\n')+'ROLLBACK;',encoding:'utf8',maxBuffer:256*1024*1024,timeout:120000 })
        assert.equal(result.status,0,result.stderr.slice(-4000))
        for (const line of result.stderr.split('\n')) if (line.includes('SAMPLE ')) {
          const sample=JSON.parse(line.slice(line.indexOf('SAMPLE ')+7))
          assert.equal(sample.response.includes('"error"') || /"error_(code|message)"\s*:\s*"/.test(sample.response),sample.name.startsWith('denied-'),`${sample.name}/${sample.manager}: ${sample.response}`)
          samples.push(sample)
        }
      }
      for(const row of cases) {
        if(completed(row)) continue
        if(connectionMode==='warm') measure([row],repeatsFor(row),'warm')
        else for(let round=0;round<repeatsFor(row);round++) for(const variant of ['before','after']) measure([row],1,'fresh',[variant],round)
        resourceCheck()
        save(false)
      }
      resourceCheck()
      save(true)
      for (const name of [...new Set(cases.map(row=>row.name))]) {
        const selected=samples.filter(sample=>sample.name===name)
        const summary={ name }
        for (const variant of ['before','after']) {
          const group=selected.filter(sample=>sample.variant===variant)
          const times=group.map(sample=>sample.plan[0]['Execution Time']).sort((a,b)=>a-b)
          summary[variant]={ calls:group.length,p50:times[Math.floor(times.length/2)],p95:times[Math.ceil(times.length*.95)-1],buffers:group.reduce((sum,sample)=>sum+(sample.plan[0].Plan['Shared Hit Blocks']??0)+(sample.plan[0].Plan['Shared Read Blocks']??0),0)/group.length }
        }
        process.stdout.write(JSON.stringify(summary)+'\n')
      }
    } else {
      throw new Error('Choose profile, quality, or bench')
    }
}
 finally { persistent?.close() }

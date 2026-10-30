import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const mini = process.env.PIPELINE_MINI === '1'
const root = process.env.PIPELINE_EVIDENCE ?? '/tmp/fable-l7/evidence'
const prefix = mini ? '642' : '648'
const project = mini ? 'pt4bafablesr' : 'pt4bafablel7'
const url = `postgresql://supabase_admin:postgres@127.0.0.1:${prefix}22/postgres`
if (!mini) assert.equal(process.env.DOCKER_CONTEXT, 'desktop-linux')
else assert.match(readFileSync('supabase/config.toml', 'utf8'), /^project_id = "pt4bafablesr"$/m)
assert.equal(process.versions.node.split('.')[0], '22')
const sql = input => execFileSync('psql', [url, '-XqAtv', 'ON_ERROR_STOP=1'], { input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
const observer = input => sql(`SET pg_stat_statements.track='none'; ${input}`)
const files = process.argv[3]?.split(',').filter(Boolean) ?? []
const baseline = files.map(file => execFileSync('git', ['show', `${process.env.PIPELINE_BASELINE_REF ?? '9862ed61'}:supabase/sql/functions/by-name/${file}.sql`], { encoding: 'utf8' })).join('\n')
const candidate = files.map(file => readFileSync(`supabase/sql/functions/by-name/${file}.sql`, 'utf8')).join('\n')
const fixture = process.env.PIPELINE_SCENARIO ? JSON.parse(readFileSync('/tmp/fable-l7/native-fixtures.json', 'utf8'))[process.env.PIPELINE_SCENARIO] : null
const expression = fixture?.expression ?? process.env.PIPELINE_EXPRESSION ?? 'public.dispatch_work()'
if (fixture?.prepare) observer(fixture.prepare)
const samples = []
const limits = JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .HostConfig}}', `supabase_db_${project}`], { encoding: 'utf8' }))
assert.equal(limits.NanoCpus, 2e9)
assert.equal(limits.Memory, 1024 ** 3)
for (let round = 0; round < 5; round++) {
  for (const phase of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    observer(`${phase === 'baseline' ? baseline : candidate}\nSELECT extensions.pg_stat_statements_reset();`)
    const output = sql(`BEGIN; SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='250ms';
      SET LOCAL app.supabase_url='http://127.0.0.1:${prefix}21'; SET LOCAL app.edge_internal_token='private-pipeline-night';
      SET LOCAL track_functions='all'; SET LOCAL pg_stat_statements.track='all';
      EXPLAIN(ANALYZE,BUFFERS,WAL,TIMING OFF,FORMAT JSON) SELECT ${expression};
      SET LOCAL pg_stat_statements.track='none';
      SELECT '@@METRICS@@';
      SELECT jsonb_build_object('pid',pg_backend_pid(),'functions',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',schemaname||'.'||funcname,'calls',calls)),'[]') FROM pg_stat_xact_user_functions WHERE calls>0),
        'runningWork',(SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'key',key) ORDER BY id),'[]') FROM private.work_items WHERE status='running'),
        'relations',(SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('name',n.nspname||'.'||c.relname,'kind',c.relkind)),'[]') FROM pg_locks l JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace WHERE l.pid=pg_backend_pid() AND n.nspname IN('public','private','analytics','net','cron')),
        'rows',(SELECT coalesce(sum(n_tup_ins+n_tup_upd+n_tup_del),0) FROM pg_stat_xact_user_tables),
        'written',(SELECT coalesce(jsonb_object_agg(schemaname||'.'||relname,n_tup_ins+n_tup_upd+n_tup_del),'{}') FROM pg_stat_xact_user_tables WHERE n_tup_ins+n_tup_upd+n_tup_del>0));
      SELECT jsonb_build_object('work',(SELECT count(*) FROM private.work_items WHERE status IN('pending','running','failed')),
        'forecast',(SELECT count(*) FROM private.matchup_forecast_queue WHERE dirty),'live',(SELECT count(*) FROM private.live_matchup_refresh_queue),
        'requests',(SELECT count(*) FROM net.http_request_queue));
      ROLLBACK;`)
    const [explain, metrics] = output.split('@@METRICS@@\n')
    const plan = JSON.parse(explain)[0]
    const [footprint, followup] = metrics.trim().split('\n').map(line => JSON.parse(line))
    const statements = JSON.parse(observer(`SELECT coalesce(jsonb_agg(jsonb_build_object('query',query,'calls',calls,'ms',total_exec_time,'hit',shared_blks_hit,'read',shared_blks_read) ORDER BY total_exec_time DESC),'[]') FROM extensions.pg_stat_statements WHERE calls>0 AND query NOT LIKE 'EXPLAIN%' AND query NOT LIKE 'SET %' AND query NOT IN ('BEGIN','ROLLBACK');`))
    samples.push({ round, phase, ...footprint, followup, ms: plan['Execution Time'], planningMs: plan['Planning Time'], hit: plan.Plan['Shared Hit Blocks'] ?? 0, read: plan.Plan['Shared Read Blocks'] ?? 0, wal: plan.Plan['WAL Bytes'] ?? 0, statements: 1+statements.reduce((n,s)=>n+s.calls,0), nested: statements })
  }
}
observer(candidate)
assert.equal(new Set(samples.map(row=>row.pid)).size,samples.length)
const summary = Object.fromEntries(['baseline','candidate'].map(phase => {
  const rows = samples.filter(row=>row.phase===phase)
  return [phase,Object.fromEntries(['ms','planningMs','statements','hit','read','wal','rows','functions','relations'].map(key=>[key,rows.reduce((n,r)=>n+(Array.isArray(r[key])?r[key].length:r[key]),0)/rows.length]))]
}))
const pairedMs = Array.from({length:5},(_,round)=>samples.find(r=>r.round===round&&r.phase==='baseline').ms-samples.find(r=>r.round===round&&r.phase==='candidate').ms)
mkdirSync(root,{recursive:true})
writeFileSync(path.join(root,`${process.argv[2] ?? 'fresh'}.json`),JSON.stringify({host:mini?'Mac mini Lima':'Docker Desktop desktop-linux',source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),concurrent:true,freshBackendPerArm:true,expression,files,summary,pairedMs,samples},null,2))
process.stdout.write(JSON.stringify({summary,pairedMs})+'\n')

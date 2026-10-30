import assert from 'node:assert/strict'
import {execFileSync,spawnSync} from 'node:child_process'
import {readFileSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {productionJobs} from '../../scripts/season-sim/cron.mjs'
assert.equal(process.env.DOCKER_CONTEXT,'desktop-linux')
const url='postgresql://postgres:postgres@127.0.0.1:64822/postgres'
const literal=value=>`'${value.replaceAll("'","''")}'`
const environment={...process.env,SUPABASE_DB_URL:url,SUPABASE_URL:'http://127.0.0.1:64821',PANCAKE_TEST_DB_PORT:'64822',PANCAKE_TEST_API_PORT:'64821',PGOPTIONS:'-c app.supabase_url=http://127.0.0.1:64821 -c app.edge_internal_token=private-pipeline-night'}
execFileSync('psql',[url.replace('postgres:postgres@','supabase_admin:postgres@'),'-XqAtv','ON_ERROR_STOP=1'],{input:'SELECT cron.unschedule(jobid) FROM cron.job;',encoding:'utf8'})
execFileSync('psql',[url,'-XqAtv','ON_ERROR_STOP=1'],{input:productionJobs.map(j=>`SELECT cron.schedule(${literal(j.jobname)},${literal(j.schedule)},${literal(j.command)});`).join('\n'),encoding:'utf8'})
const recipes=['pipeline-night-forecast-admission','pipeline-night-forecast-starvation','forecast-input-fingerprint','forecast-input-write-gate','forecast-queue-write-gate','work-queue-forecasts','work-queue-gates','work-queue-lifecycle','cron-chunk-boundaries','live-refresh-shed','scheduler-health','matchup-forecast-cache','matchup-forecast-cache-parity']
const results=[]
for(const name of recipes){
 const source=readFileSync(`tests/db/${name}.sql`,'utf8').replaceAll('http://127.0.0.1:1','http://127.0.0.1:64821').replace(/^\\getenv (\w+) (\w+)$/gm,(_,variable,key)=>`\\set ${variable} '${environment[key]??''}'`)
 const r=spawnSync('psql',[url,'-Xq','-v','ON_ERROR_STOP=1','-v','chunk_api_url=http://127.0.0.1:64821','-v','forecast_api_url=http://127.0.0.1:64821','-f','-'],{input:source,encoding:'utf8',env:environment,cwd:path.resolve('tests/db'),maxBuffer:8*1024*1024})
 writeFileSync(`/tmp/fable-l7/evidence/forecast-${name}.log`,r.stdout+r.stderr)
 results.push({name,passed:r.status===0})
 process.stdout.write(`${name}: ${r.status===0?'PASS':r.stderr.slice(-700)}\n`)
}
writeFileSync('/tmp/fable-l7/evidence/forecast-verification.json',JSON.stringify(results,null,2))
assert.ok(results.every(row=>row.passed))

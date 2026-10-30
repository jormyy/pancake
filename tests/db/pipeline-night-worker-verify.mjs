import assert from 'node:assert/strict'
import {execFileSync,spawnSync} from 'node:child_process'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import path from 'node:path'
import {productionJobs} from '../../scripts/season-sim/cron.mjs'

const port=process.env.PIPELINE_DB_PORT??'64222'
assert.equal(port,'64222')
assert.match(readFileSync('supabase/config.toml','utf8'),/^project_id = "pt4bafablesr"$/m)
const url=`postgresql://postgres:postgres@127.0.0.1:${port}/postgres`
const api='http://127.0.0.1:64221'
const literal=value=>`'${value.replaceAll("'","''")}'`
const environment={...process.env,SUPABASE_DB_URL:url,SUPABASE_URL:api,PANCAKE_TEST_DB_PORT:port,PANCAKE_TEST_API_PORT:'64221',PGOPTIONS:`-c app.supabase_url=${api} -c app.edge_internal_token=private-pipeline-night`}
const destination=process.env.PIPELINE_EVIDENCE
assert.ok(destination)
mkdirSync(destination,{recursive:true})
execFileSync('psql',[url.replace('postgres:postgres@','supabase_admin:postgres@'),'-XqAtv','ON_ERROR_STOP=1'],{input:'SELECT cron.unschedule(jobid) FROM cron.job;',encoding:'utf8'})
execFileSync('psql',[url,'-XqAtv','ON_ERROR_STOP=1'],{input:productionJobs.map(j=>`SELECT cron.schedule(${literal(j.jobname)},${literal(j.schedule)},${literal(j.command)});`).join('\n'),encoding:'utf8'})
const results=[]
for(const name of ['pipeline-night-worker-fairness','pipeline-night-forecast-starvation','work-queue-revaluation-pacing','work-queue-lifecycle','work-queue-gates','work-queue-forecasts','cron-chunk-boundaries','live-refresh-shed','scheduler-health']){
  const source=readFileSync(`tests/db/${name}.sql`,'utf8').replaceAll('http://127.0.0.1:64821',api).replaceAll('http://127.0.0.1:1',api)
    .replace(/^\\getenv (\w+) (\w+)$/gm,(_,variable,key)=>`\\set ${variable} '${environment[key]??''}'`)
  const result=spawnSync('psql',[url,'-Xq','-v','ON_ERROR_STOP=1',`-v`,`chunk_api_url=${api}`,'-v',`forecast_api_url=${api}`,'-f','-'],{
    input:source,encoding:'utf8',env:environment,cwd:path.resolve('tests/db'),maxBuffer:8*1024*1024,
  })
  writeFileSync(path.join(destination,`${name}.log`),result.stdout+result.stderr)
  results.push({name,passed:result.status===0})
  process.stdout.write(`${name}: ${result.status===0?'PASS':result.stderr.slice(-1500)}\n`)
}
writeFileSync(path.join(destination,'worker-verification.json'),JSON.stringify(results,null,2)+'\n')
assert.ok(results.every(row=>row.passed))

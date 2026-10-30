import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { productionJobs } from '../../scripts/season-sim/cron.mjs'

assert.equal(process.env.DOCKER_CONTEXT,'desktop-linux')
const url='postgresql://postgres:postgres@127.0.0.1:64822/postgres'
const evidence='/tmp/fable-l7/evidence'
mkdirSync(evidence,{recursive:true})
const literal=value=>`'${value.replaceAll("'","''")}'`
execFileSync('psql',[url.replace('postgres:postgres@','supabase_admin:postgres@'),'-XqAtv','ON_ERROR_STOP=1'],{input:'SELECT cron.unschedule(jobid) FROM cron.job; GRANT USAGE,CREATE ON SCHEMA pipeline_night_lab TO postgres; ALTER FUNCTION pipeline_night_lab.hint_drain() OWNER TO postgres;',encoding:'utf8'})
execFileSync('psql',[url,'-XqAtv','ON_ERROR_STOP=1'],{input:productionJobs.map(job=>`SELECT cron.schedule(${literal(job.jobname)},${literal(job.schedule)},${literal(job.command)});`).join('\n'),encoding:'utf8'})
const hint=productionJobs.find(job=>job.jobname==='io-hint-drain').command
const body=hint.slice(hint.indexOf('DO $job$')+9,hint.lastIndexOf('$job$;'))
execFileSync('psql',[url,'-XqAtv','ON_ERROR_STOP=1'],{input:`CREATE OR REPLACE FUNCTION pipeline_night_lab.hint_drain() RETURNS void LANGUAGE plpgsql AS $lab$ ${body} $lab$;`,encoding:'utf8'})
const environment={...process.env,SUPABASE_DB_URL:url,SUPABASE_URL:'http://127.0.0.1:64821',PANCAKE_TEST_DB_PORT:'64822',PANCAKE_TEST_API_PORT:'64821',PGOPTIONS:'-c statement_timeout=120s -c app.supabase_url=http://127.0.0.1:64821 -c app.edge_internal_token=private-pipeline-night'}
const results=[]
for(const name of ['pipeline-night-hint-lease','pipeline-night-poll','work-queue-live-poll','work-queue-gates','work-queue-trades','work-queue-forecasts','work-queue-schedules','work-queue-lifecycle','scheduler-health','live-refresh-shed','cron-chunk-boundaries','live-player-stats-hints','server-inventory-hint-cron']){
  const source=readFileSync(`tests/db/${name}.sql`,'utf8').replaceAll('http://127.0.0.1:1','http://127.0.0.1:64821').replace(/^\\getenv (\w+) (\w+)$/gm,(_,variable,key)=>`\\set ${variable} '${environment[key] ?? ''}'`)
  const result=spawnSync('psql',[url,'-Xq','-v','ON_ERROR_STOP=1','-v','chunk_api_url=http://127.0.0.1:64821','-f','-'],{input:source,env:environment,cwd:path.resolve('tests/db'),encoding:'utf8',maxBuffer:8*1024*1024})
  writeFileSync(path.join(evidence,`${name}-local.log`),result.stdout+result.stderr)
  results.push({name,passed:result.status===0})
  process.stdout.write(`${name}: ${result.status===0?'PASS':result.stderr.slice(-900)}\n`)
}
writeFileSync(path.join(evidence,'local-verification.json'),JSON.stringify(results,null,2))
assert.ok(results.every(row=>row.passed))

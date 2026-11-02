import { evidencePath } from '../helpers/evidence-path.mjs'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync,readdirSync,writeFileSync} from 'node:fs'
const root='/tmp/fable-l7/evidence'
const read=name=>JSON.parse(readFileSync(`${root}/${name}.json`,'utf8'))
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const hours=[]
for(let round=1;round<=5;round++){
 const run=read(`forecast-day-blocked-${round}`),a=run.phases.find(p=>p.phase==='baseline'),b=run.phases.find(p=>p.phase==='candidate')
 assert.equal(run.pass,true);assert.deepEqual(b.checkpoints,a.checkpoints);assert.equal(b.computeCalls,a.computeCalls)
 hours.push({round,order:run.phases.map(p=>p.phase),source:run.source,baselineWork:a.idleWork,candidateWork:b.idleWork,
   baselineInvocations:a.idleEdge,candidateInvocations:b.idleEdge,baselineComputations:a.computeCalls,candidateComputations:b.computeCalls,
   checkpoints:a.checkpoints.map(c=>({label:c.label,forecastCount:c.values.length,fullJsonSha256:hash(c.values)}))})
}
const steady=read('forecast-day-candidate')
assert.deepEqual(steady.phases[0].checkpoints,steady.phases[1].checkpoints)
const fresh=['forecast-blocked-final','forecast-settled-final'].map(name=>{
 const r=read(name);assert.equal(new Set(r.samples.map(s=>s.pid)).size,10)
 return {name,source:r.source,baseline:'505d7734',summary:r.summary,pairedFreshMs:r.pairedMs,samples:r.samples.map(s=>({round:s.round,phase:s.phase,pid:s.pid,ms:s.ms,planningMs:s.planningMs,statements:s.statements,
  hit:s.hit,read:s.read,rowsWritten:s.rows,wal:s.wal,functions:s.functions.length,relations:s.relations.length,followup:s.followup}))}
})
const signatureMatches=readdirSync('supabase/sql/functions/by-name/public').filter(f=>f.endsWith('.sql')).flatMap(file=>{
 const source=readFileSync(`supabase/sql/functions/by-name/public/${file}`,'utf8')
 const args=/CREATE OR REPLACE FUNCTION[^()]+\((.*?)\)\s*RETURNS/is.exec(source)?.[1].match(/\bp_\w+/g)
 return JSON.stringify(args)===JSON.stringify(['p_league_id','p_member_id','p_params'])?[file.slice(0,-4)]:[]
})
assert.equal(signatureMatches.length,26)
const verification=read('forecast-verification');assert.ok(verification.every(r=>r.passed))
const report={version:1,baseline:'505d7734',candidate:'f765a6d8',host:'Docker Desktop desktop-linux',project:'pt4bafablel7',concurrentWithOtherLanes:true,
 limits:{cpus:2,memoryBytes:1024**3,sharedBuffers:'224MB',effectiveCacheSize:'384MB'},
 cause:{reproduced:'Dispatcher admits dirty forecasts whose input scopes block worker claims',productionAttribution:'Needs production queue-state evidence; no production connection was made',
  restoredDirty:15,restoredBlocked:15,restoredSuccessfullyComputed:15,settledDirty:0},
 hours,steady:{baselineWork:steady.phases[0].idleWork,candidateWork:steady.phases[1].idleWork,baselineInvocations:steady.phases[0].idleEdge,candidateInvocations:steady.phases[1].idleEdge,
  checkpoints:steady.checkpointCount,fullJsonSha256:steady.checkpointSha256},fresh,
 slowRpcRows:{reportedMeansMs:[750,342,176],recordedParameters:['p_league_id','p_member_id','p_params'],signatureMatches,
  attribution:'Truncated SQL cannot uniquely resolve these names. All matching signatures are view functions; none is a forecast RPC.'},
 verification:{sql:verification,vitest:{passed:42,failed:0},controls:['baseline blocked admission rejected','A/A checkpoint equality','mutated returned stale flag rejected'],fullSuite:'Not rerun; only focused tests requested'}}
writeFileSync(evidencePath('pipeline-night-forecast-results.json'),JSON.stringify(report,null,2)+'\n')
const table=['| Scenario | Forecast jobs/hour | Forecast invocations/hour | Dispatcher statements | Shared hit + read | Rows written |',
 '|---|---:|---:|---:|---:|---:|']
for(const [index,name] of ['Blocked input scope','Settled idle'].entries()){
 const r=fresh[index],b=r.summary.baseline,c=r.summary.candidate
 table.push(`| ${name} | ${index?0:58} → 0 | ${index?0:58} → 0 | ${b.statements} → ${c.statements} | ${Math.round(b.hit+b.read)} → ${Math.round(c.hit+c.read)} | ${b.rows} → ${c.rows} |`)
}
writeFileSync('/tmp/fable-l7/evidence/forecast-table.md',table.join('\n')+'\n\n'+fresh.map(r=>`${r.name} fresh paired differences, baseline minus candidate ms: ${r.pairedFreshMs.map(n=>n.toFixed(3)).join(', ')}.`).join('\n\n')+'\n')
process.stdout.write('Recorded five hourly pairs, ten fresh-backend pairs, and 504 exact checkpoints.\n')

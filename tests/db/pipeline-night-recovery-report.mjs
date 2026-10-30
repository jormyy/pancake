import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync,writeFileSync} from 'node:fs'

const root='/tmp/fable-l7/evidence'
const read=name=>JSON.parse(readFileSync(`${root}/${name}.json`,'utf8'))
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const reportFile='tests/db/pipeline-night-input-recovery-results.json'
const report=JSON.parse(readFileSync(reportFile,'utf8'))
const pairs=[]
for(let round=1;round<=5;round++){
 const r=read(`forecast-day-recovery-blocked-${round}`),a=r.phases.find(p=>p.phase==='baseline'),b=r.phases.find(p=>p.phase==='candidate')
 assert.equal(r.baselineRef,'c84063c4');assert.equal(r.pass,true);assert.deepEqual(a.checkpoints,b.checkpoints)
 assert.equal(a.computeCalls,b.computeCalls);assert.equal(a.idleWork,58);assert.equal(b.idleWork,0);assert.equal(a.idleStart.leased,0);assert.equal(b.idleStart.leased,0)
 pairs.push({round,order:r.phases.map(p=>p.phase),source:r.source,baselineWork:a.idleWork,candidateWork:b.idleWork,baselineInvocations:a.idleEdge,candidateInvocations:b.idleEdge,
  baselineComputations:a.computeCalls,candidateComputations:b.computeCalls,initialWorkload:a.idleStart,
  checkpoints:a.checkpoints.map(c=>({label:c.label,forecasts:c.values.length,fullJsonSha256:hash(c.values)}))})
}
const steady=read('forecast-day-recovery-steady'),a=steady.phases[0],b=steady.phases[1]
assert.deepEqual(a.checkpoints,b.checkpoints);assert.equal(a.idleWork,0);assert.equal(b.idleWork,0)
const fresh=['recovery-priority','recovery-settled','recovery-blocked'].map(name=>{
 const r=read(name);assert.equal(new Set(r.samples.map(s=>s.pid)).size,10)
 const before=r.samples.filter(s=>s.phase==='baseline'),after=r.samples.filter(s=>s.phase==='candidate')
 if(name==='recovery-priority'){
  assert.ok(before.every(s=>!s.runningWork.some(w=>w.kind==='forecast-inputs')))
  assert.ok(after.every(s=>s.runningWork.some(w=>w.kind==='forecast-inputs')))
 }
 const mean=r.summary.baseline.ms,spread=Math.max(...before.map(s=>s.ms))-Math.min(...before.map(s=>s.ms))
 return {name,source:r.source,baselineRef:'c84063c4',isolatedFunctions:r.files,summary:r.summary,pairedFreshMs:r.pairedMs,timeNoiseMs:Math.max(spread,mean*.1),
  timeGainBeyondNoise:mean-r.summary.candidate.ms>Math.max(spread,mean*.1),samples:r.samples.map(s=>({round:s.round,phase:s.phase,pid:s.pid,ms:s.ms,statements:s.statements,
    hit:s.hit,read:s.read,rowsWritten:s.rows,wal:s.wal,functions:s.functions.length,relations:s.relations.length,runningWork:s.runningWork,followup:s.followup}))}
})
report.candidate='9894ce0c'
report.hourPairs=pairs
report.steady={source:steady.source,checkpoints:steady.checkpointCount,baselineWork:a.idleWork,candidateWork:b.idleWork,baselineInvocations:a.idleEdge,candidateInvocations:b.idleEdge,fullJsonSha256:steady.checkpointSha256}
report.fresh=fresh
report.validation.dayCheckpoints=504
report.validation.sql=read('forecast-verification')
assert.ok(report.validation.sql.every(r=>r.passed))
writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n')
const lines=['| Fresh scenario | Statements | Shared hit + read | Rows written | WAL bytes | Functions | Relations |',
 '|---|---:|---:|---:|---:|---:|---:|']
for(const r of fresh){
 const a=r.summary.baseline,b=r.summary.candidate
 lines.push(`| ${r.name} | ${a.statements} → ${b.statements} | ${Math.round(a.hit+a.read)} → ${Math.round(b.hit+b.read)} | ${a.rows} → ${b.rows} | ${Math.round(a.wal)} → ${Math.round(b.wal)} | ${a.functions} → ${b.functions} | ${a.relations} → ${b.relations} |`)
}
writeFileSync(`${root}/recovery-table.md`,lines.join('\n')+'\n\n'+fresh.map(r=>`${r.name}: ${r.pairedFreshMs.map(n=>n.toFixed(3)).join(', ')} ms; noise ${r.timeNoiseMs.toFixed(3)} ms.`).join('\n')+'\n')
process.stdout.write(`Retained ${pairs.length} hourly pairs, ${fresh.length*5} fresh pairs, and 504 exact checkpoint comparisons.\n`)

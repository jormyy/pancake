import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFileSync,writeFileSync} from 'node:fs'
import path from 'node:path'

const directory=process.env.PIPELINE_EVIDENCE??'/tmp/fable-l7/evidence/l7-5'
const read=name=>JSON.parse(readFileSync(path.join(directory,`${name}.json`),'utf8'))
if(process.argv.includes('--db')){
  assert.match(readFileSync('supabase/config.toml','utf8'),/^project_id = "pt4bafablesr"$/m)
  const output=execFileSync('psql',['postgresql://postgres:postgres@127.0.0.1:64222/postgres','-XqAtv','ON_ERROR_STOP=1'],{encoding:'utf8',input:`
    SELECT jsonb_build_object('seeded',count(*),'succeeded',count(*) FILTER(WHERE w.status='succeeded'),
      'elapsedSeconds',extract(epoch FROM max(w.completed_at)-min(w.created_at)),
      'revaluationStartGaps',(SELECT jsonb_agg(gap ORDER BY started_at) FROM (
        SELECT e.worker_started_at AS started_at,extract(epoch FROM e.worker_started_at-lag(e.worker_started_at) OVER(ORDER BY e.worker_started_at)) AS gap
        FROM public.edge_invocations e JOIN pipeline_night_lab.seeded_work s ON s.id=e.work_item_id
        WHERE s.kind='trade-revaluation') r WHERE gap IS NOT NULL))
      FROM pipeline_night_lab.seeded_work s JOIN private.work_items w ON w.id=s.id;`})
  const result=JSON.parse(output)
  assert.equal(result.seeded,389);assert.equal(result.succeeded,389)
  assert.equal(result.revaluationStartGaps.length,7)
  assert.ok(result.revaluationStartGaps.every(gap=>gap>=59))
  writeFileSync(path.join(directory,'worker-observed.json'),JSON.stringify(result,null,2)+'\n')
  process.stdout.write(output)
  process.exit(0)
}
const mix=read('worker-mix'),native=read('worker-native'),fresh=read('worker-mix-fresh')
const checks=native.events.filter(event=>event.kind==='trade-revaluation-check')
assert.deepEqual(checks.slice(0,330).map(event=>event.key),Array.from({length:330},(_,n)=>`worker-old-check-${n+1}`))
const selected=native.events.filter(event=>/^worker-(old-check-|failed-check-|scan-|revaluation-|notification-|inputs-)/.test(event.key))
assert.equal(selected.length,389)
assert.equal(native.state.remaining,0);assert.equal(native.state.oldChecks,330);assert.equal(native.state.dueRequests,0)
assert.equal(selected.filter(event=>event.attempts===2).length,8)
assert.equal(new Set(fresh.samples.map(sample=>sample.pid)).size,10)
const baselineTimes=fresh.samples.filter(sample=>sample.phase==='baseline').map(sample=>sample.ms)
const byKind=Object.fromEntries([...new Set(selected.map(event=>event.kind))].sort().map(kind=>{
  const rows=selected.filter(event=>event.kind===kind)
  return [kind,{count:rows.length,firstTick:Math.min(...rows.map(row=>row.tick)),lastTick:Math.max(...rows.map(row=>row.tick))}]
}))
const result={verifiedCode:'4f24d4b1',source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  migration:'20261214005408_background_kind_fairness.sql',migrationSha256:createHash('sha256').update(readFileSync('supabase/migrations/20261214005408_background_kind_fairness.sql')).digest('hex'),
  mix:mix.map(({first,...row})=>row),native:{seeded:389,completed:389,oldCheckFIFO:true,failedSecondAttempts:8,forecastsCompared:native.forecastsCompared,
    state:native.state,rpcCalls:native.calls,byKind,observed:read('worker-observed'),otherWorkersModeled:true},
  fresh:{baseline:'c84063c4',pairs:5,concurrent:true,freshBackendPerArm:true,backendPids:fresh.samples.map(sample=>sample.pid),summary:fresh.summary,
    pairedMs:fresh.pairedMs,noiseMs:Math.max(Math.max(...baselineTimes)-Math.min(...baselineTimes),baselineTimes.reduce((a,b)=>a+b)/5*.1),costGain:false},
  sql:read('worker-verification'),catalog:read('worker-catalog'),restart:read('worker-restart'),
  productionWithinKindBypassReproduced:false}
assert.ok(result.sql.every(row=>row.passed))
writeFileSync('tests/db/pipeline-night-worker-results.json',JSON.stringify(result,null,2)+'\n')
process.stdout.write(JSON.stringify({native:result.native.byKind,forecastsCompared:result.native.forecastsCompared,pairs:5,noiseMs:result.fresh.noiseMs})+'\n')

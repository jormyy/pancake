import { evidencePath } from '../helpers/evidence-path.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const root='/tmp/fable-l7/evidence'
const read=name=>JSON.parse(readFileSync(`${root}/${name}.json`,'utf8'))
const names=['final-dispatcher-idle','final-dispatcher-active','poll-final-idle','hints-combined-final','recheck-context-compatible',
  'recheck-live-new','recheck-live-duplicate','recheck-prepare-fresh','recheck-prepare-reuse','recheck-context-prepared','recheck-forecast-write','recheck-matchup-write','recheck-capture-score',
  'idle-trade-probe','idle-trade-caller','idle-draft-probe','maintenance-not-due','native-aa','idle-clean-aa']
const excludeOuter=new Set(['poll-final-idle','idle-trade-probe','idle-trade-caller','idle-draft-probe','native-aa','idle-clean-aa'])
const footprints={functions:{},relations:{}}
const footprint=(kind,rows)=>{
  const ordered=[...rows].sort((a,b)=>a.name.localeCompare(b.name))
  const hash=createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
  footprints[kind][hash]=ordered
  return hash
}
const measures=names.map(name=>{
  const source=read(name)
  assert.equal(source.samples.length,10)
  assert.equal(new Set(source.samples.map(row=>row.pid)).size,10)
  const samples=source.samples.map(row=>({round:row.round,phase:row.phase,pid:row.pid,ms:row.ms,planningMs:row.planningMs,statements:row.statements+(excludeOuter.has(name)?1:0),buffers:row.hit+row.read,hit:row.hit,read:row.read,
    wal:row.wal,rows:row.rows,functions:row.functions.length,relations:row.relations.length,functionFootprint:footprint('functions',row.functions),relationFootprint:footprint('relations',row.relations),followup:row.followup}))
  const keys=['statements','buffers','rows','wal','functions','relations']
  const value=(row,key)=>Array.isArray(row[key])?row[key].length:row[key]
  const average=(rows,key)=>rows.reduce((total,row)=>total+value(row,key),0)/rows.length
  const before=samples.filter(row=>row.phase==='baseline'),after=samples.filter(row=>row.phase==='candidate')
  const metrics=Object.fromEntries(keys.map(key=>{
    const baseline=average(before,key),candidate=average(after,key)
    const noise=Math.max(baseline*.1,Math.max(...before.map(row=>value(row,key)))-Math.min(...before.map(row=>value(row,key))))
    return [key,{baseline,candidate,noise,gain:baseline-candidate,beyondNoise:baseline-candidate>noise}]
  }))
  return {name,source:source.source,baselineRef:source.files.length ? name==='recheck-context-compatible'?'952580ce':'9862ed61' : null,baselineFiles:source.files,freshBackendPerArm:true,metrics,pairedFreshMs:source.pairedMs,samples}
})
const qualityNames=['local-poll-due-quality','final-dispatch-quality','inline-quality-dispatch-shed','inline-quality-dispatch-paused','final-cycle-same-xid','hints-empty-quality','hints-due-quality','hints-throttled-quality']
const quality=qualityNames.flatMap(name=>read(name).quality.map(row=>{
  const frames=row.name==='live-cycle'?row.values.map((value,index)=>{
    const visible=value.visible.find(item=>item.matchup_id===value.context.matchupId)
    assert.ok(visible)
    assert.equal(visible.home_points,value.context.teams[0].currentPoints)
    assert.equal(visible.away_points,value.context.teams[1].currentPoints)
    return {frame:index+1,currentTotalsVisible:true}
  }):undefined
  return {name:row.name,pass:row.pass,touched:row.touched,comparisonSha256:row.hash,
    returnedSha256:createHash('sha256').update(JSON.stringify(row.values)).digest('hex'),frames}
}))
const stack=read('stack')
const report={version:1,host:'Docker Desktop desktop-linux',project:'pt4bafablel7',concurrentWithOtherLanes:true,
  resources:{cpus:2,memoryBytes:1024**3,sharedBuffers:stack.settings.shared_buffers,effectiveCacheSize:stack.settings.effective_cache_size},
  backup:{hashes:stack.hashes,rows:stack.backupRows,tupleHash:stack.tupleHash},
  footprint:'Executed user functions from pg_stat_xact_user_functions; application tables and indexes locked after the call. These are catalog footprint proxies, not syscache miss counters.',
  statements:'pg_stat_statements calls with nested tracking plus one outer invocation; instrumentation excluded.',
  quality,measures,footprints,
  verification:{focusedSqlPassed:13,knownBaselineFailures:['work-queue-pre-tipoff: started player lock context','io-write-reductions: unchanged screen publication'],
    hintTimeoutChecks:10,cronPolicyChecks:2,leaseExceptionCases:7,
    fullVitest:{passed:4918,failed:1,skipped:48,failure:'Temporary local config port override'},
    focusedVitestAfterCleanup:{passed:55,failed:0},lintAll:true,typecheck:true,typecheckTests:true,knip:true,negativeControls:['returned value','touched row','same-transaction live-cycle row','expired header lease bypass before fix'],sourceParity:true,liveCatalog:true}}
writeFileSync(evidencePath('pipeline-night-local-results.json'),JSON.stringify(report,null,2)+'\n')
const number=value=>Math.round(value).toLocaleString('en-US')
const pair=(m,key)=>`${number(m.metrics[key].baseline)} → ${number(m.metrics[key].candidate)}`
let table='\n| Local scenario | Statements | Shared hit + read | Functions | Relations | Rows written | WAL bytes |\n|---|---:|---:|---:|---:|---:|---:|\n'
for(const m of measures.slice(0,13))table+=`| ${m.name} | ${pair(m,'statements')} | ${pair(m,'buffers')} | ${pair(m,'functions')} | ${pair(m,'relations')} | ${pair(m,'rows')} | ${pair(m,'wal')} |\n`
table+='\nFresh paired differences are baseline minus candidate milliseconds, in interleaved pair order. Positive values favor the candidate. Time is not used to accept the ingest and forecast rechecks.\n\n'
for(const m of measures.slice(0,5))table+=`- ${m.name}: ${m.pairedFreshMs.map(n=>n.toFixed(3)).join(', ')}.\n`
writeFileSync('/tmp/fable-l7/evidence/local-table.md',table)
process.stdout.write('Wrote 19 experiments with 95 fresh-backend pairs and eight exact quality comparisons.\n')

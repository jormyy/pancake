import { evidencePath } from '../helpers/evidence-path.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pairedComparisons, percentile } from './league-actions-metrics.mjs'

const directory=process.argv[2]
assert.ok(directory,'Pass the copied evidence directory')
const source=readFileSync(path.join(directory,'final-samples.json'))
const samples=JSON.parse(source)
const parity=JSON.parse(readFileSync(path.join(directory,'final-parity.json'),'utf8'))
const inventory=JSON.parse(readFileSync(path.join(directory,'inventory.json'),'utf8'))
const scenario={seasonYear:inventory.fixture.year,projectionDate:inventory.fixture.date,gameDate:inventory.fixture.today,managers:inventory.fixture.members.length,playerIds:inventory.fixture.players.length,visiblePlayerIds:inventory.fixture.visiblePlayers.length}
const metadata=JSON.parse(readFileSync(path.join(directory,'final-metadata.json'),'utf8'))
assert.equal(metadata.scoped,true)
const caseKey=row=>`${row.name}/${row.variant??'default'}/${row.manager}`
assert.deepEqual([...new Set(samples.map(caseKey))].sort(),metadata.selected.map(caseKey).sort())
const installed=JSON.parse(readFileSync(path.join(directory,'installed-catalog.json'),'utf8'))
assert.deepEqual(installed.migrations,['20261214005300','20261214005301','20261214005302'])
assert.ok(Object.values(installed.functions).every(Boolean))
assert.deepEqual([...new Set(samples.filter(row=>row.variant==='default').map(row=>row.name))].sort(),[...new Set(inventory.cases.map(row=>row.name))].sort())
assert.equal(parity.length,219)
for(const manager of [1,2,3]) assert.equal(parity.filter(row=>row.manager===manager).length,73)
const paired=pairedComparisons(samples)
const groups=Map.groupBy(samples,row=>`${row.name}/${row.variant}/${row.manager}/${row.version}/${row.state}`)
const categories={publication:/league_version|publish_league_version/,refresh:/refresh|revision/,notification:/notif_|notification|fanout/}
const summary=[...groups.values()].map(rows=>{
  assert.ok(rows.length>=5)
  const row=rows[0]
  return {name:row.name,variant:row.variant,manager:row.manager,version:row.version,state:row.state,n:rows.length,
    ...Object.fromEntries(['milliseconds','buffers','wal','written','bytes','statements'].map(key=>[key,{p50:percentile(rows.map(row=>row[key]),0.5),p95:percentile(rows.map(row=>row[key]),0.95),spread:Math.max(...rows.map(row=>row[key]))-Math.min(...rows.map(row=>row[key]))}]))}
})
const writes=(row,pattern)=>row.writes.filter(write=>pattern.test(write.relname)).reduce((sum,write)=>sum+write.inserted+write.updated+write.deleted,0)
const work=row=>({versions:writes(row,/^league_versions$/),refresh:writes(row,/refresh.*(queue|requests)|work_items/),notifications:writes(row,/^notification_outbox$/)})
const combinations=[...new Map(samples.map(row=>[`${row.name}/${row.variant}`,{name:row.name,variant:row.variant}])).values()]
const lines=['| Action / scenario | Calls A/B | Fresh DB ms p50/p95 A → B | Warm DB ms p50/p95 A → B | Buffers fresh; warm A → B | WAL A → B | DB JSON bytes A → B | Row mutations A → B | Statements A → B | Follow-up writes V/R/N A → B |','| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |']
const differences=['| Action / scenario | Fresh paired DB ms Δ p50 / p95 | Warm paired DB ms Δ p50 / p95 | Warm buffer reduction range |','| --- | ---: | ---: | ---: |']
for(const {name,variant} of combinations){
  assert.deepEqual([...new Set(samples.filter(row=>row.name===name&&row.variant===variant).map(row=>row.manager))].sort(),[1,2,3])
  for(const manager of [1,2,3]) assert.ok(parity.some(row=>row.name===name&&row.variant===variant&&row.manager===manager),'Every measured scenario needs a completed parity gate')
  const select=(version,state)=>summary.filter(row=>row.name===name&&row.variant===variant&&row.version===version&&row.state===state)
  const maximum=(version,state,key,p)=>Math.max(...select(version,state).map(row=>row[key][p]))
  const timing=(version,state)=>`${maximum(version,state,'milliseconds','p50').toFixed(2)}/${maximum(version,state,'milliseconds','p95').toFixed(2)}`
  const metric=(key,state='warm')=>['baseline','candidate'].map(version=>maximum(version,state,key,'p95')).join(' → ')
  const followup=version=>{
    const rows=samples.filter(row=>row.name===name&&row.variant===variant&&row.version===version&&row.state==='warm').map(work)
    return ['versions','refresh','notifications'].map(key=>Math.max(...rows.map(row=>row[key]))).join('/')
  }
  const label=variant==='default'?name:`${name} / ${variant}`
  const calls=version=>samples.filter(row=>row.name===name&&row.variant===variant&&row.version===version).length
  lines.push(`| ${label} | ${calls('baseline')}/${calls('candidate')} | ${timing('baseline','fresh')} → ${timing('candidate','fresh')} | ${timing('baseline','warm')} → ${timing('candidate','warm')} | ${metric('buffers','fresh')}; ${metric('buffers')} | ${metric('wal')} | ${metric('bytes')} | ${metric('written')} | ${metric('statements')} | ${followup('baseline')} → ${followup('candidate')} |`)
  const pairs=state=>paired.filter(row=>row.name===name&&row.variant===variant&&row.state===state)
  const delta=state=>['deltaP50','deltaP95'].map(key=>`${Math.min(...pairs(state).map(row=>row.metrics.milliseconds[key])).toFixed(2)}…${Math.max(...pairs(state).map(row=>row.metrics.milliseconds[key])).toFixed(2)}`).join(' / ')
  const reductions=pairs('warm').map(row=>100*(row.metrics.buffers.beforeP50-row.metrics.buffers.afterP50)/row.metrics.buffers.beforeP50)
  differences.push(`| ${label} | ${delta('fresh')} | ${delta('warm')} | ${Math.min(...reductions).toFixed(1)}…${Math.max(...reductions).toFixed(1)}% |`)
}
const followups=[...groups.values()].map(rows=>{
  const row=rows[0]
  return {name:row.name,variant:row.variant,manager:row.manager,version:row.version,state:row.state,
    writes:work(row),tableMutations:row.writes,triggers:row.functions.filter(fn=>fn.trigger).map(({schemaname,funcname,calls})=>({schemaname,funcname,calls})),
    categories:Object.fromEntries(Object.entries(categories).map(([category,pattern])=>{
      const self=rows.map(row=>row.functions.filter(fn=>pattern.test(fn.funcname)).reduce((sum,fn)=>sum+fn.self_time,0))
      const shares=self.map((value,index)=>100*value/rows[index].milliseconds)
      return [category,{selfMsP50:percentile(self,0.5),selfMsP95:percentile(self,0.95),sharePctP50:percentile(shares,0.5),functions:row.functions.filter(fn=>pattern.test(fn.funcname))}]
    }))}
})
assert.ok(parity.every(row=>row.equal&&row.responseControl==='rejected'&&row.rowControl==='rejected'))
const privateHelpers=Object.fromEntries([...new Set(samples.map(row=>row.name))].map(name=>[name,[...new Set(samples.filter(row=>row.name===name).flatMap(row=>row.functions.filter(fn=>fn.schemaname==='private').map(fn=>fn.funcname)))].sort()]))
writeFileSync(evidencePath('league-actions-results.json'),JSON.stringify({concurrentWithOtherLanes:true,installed,scenario,measurement:{harnessSha256:metadata.harness,scoped:metadata.scoped,transport:'CLI local psql'},runtime:JSON.parse(readFileSync(path.join(directory,'stack.json'),'utf8')),sampleSha256:createHash('sha256').update(source).digest('hex'),windows:[...new Set(samples.map(row=>row.window))],samples:samples.length,summary,paired,privateHelpers,followups,parity},null,2)+'\n')
writeFileSync(evidencePath('league-actions-table.md'),lines.join('\n')+'\n\n'+differences.join('\n')+'\n')
process.stdout.write(JSON.stringify({samples:samples.length,groups:summary.length,parity:parity.length})+'\n')

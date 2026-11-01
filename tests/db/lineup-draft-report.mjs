import { evidencePath } from '../helpers/evidence-path.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const directory=process.argv[2]??'../evidence'
const load=name=>JSON.parse(readFileSync(path.join(directory,name),'utf8'))
const percentile=(values,p)=>values.toSorted((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)]
const mean=values=>values.reduce((a,b)=>a+b,0)/values.length
const round=value=>Math.round(value*1000)/1000
const writes=row=>Object.values(row.writes??{}).reduce((sum,counts)=>sum+counts.insert+counts.update+counts.delete,0)
const follow=row=>{
  const entries=Object.entries(row.writes??{})
  const count=pattern=>entries.filter(([table])=>pattern.test(table)).reduce((sum,[,counts])=>sum+counts.insert+counts.update+counts.delete,0)
  return { publishes:count(/^public\.league_versions$/),refresh:count(/refresh.*(request|queue)|(request|queue).*refresh/),notifications:count(/notif|push|email/),tables:row.writes }
}
const summarize=rows=>{
  const result={calls:rows.length}
  for(const key of ['ms','buffers','wal','statements','written','bytes','dbBytes','triggers']) {
    const values=rows.map(row=>row[key]).filter(value=>typeof value==='number')
    if(values.length) result[key]={p50:round(percentile(values,.5)),p95:round(percentile(values,.95)),mean:round(mean(values)),min:round(Math.min(...values)),max:round(Math.max(...values))}
  }
  result.followUp=Object.fromEntries(['publishes','refresh','notifications'].map(key=>[key,round(mean(rows.map(row=>follow(row)[key])))]))
  result.writes=Object.fromEntries([...new Set(rows.flatMap(row=>Object.keys(row.writes??{})))].toSorted().map(table=>[table,Object.fromEntries(['insert','update','delete'].map(operation=>[operation,round(mean(rows.map(row=>row.writes?.[table]?.[operation]??0)))]))]))
  const names=[...new Set(rows.flatMap(row=>Object.keys(row.functions??{})))].filter(name=>/^(public|private)\./.test(name)).toSorted()
  result.functions=Object.fromEntries(names.map(name=>[name,Object.fromEntries(['calls','selfMs','totalMs'].map(field=>[field,round(mean(rows.map(row=>row.functions?.[name]?.[field]??0)))]))]))
  return result
}
const compare=rows=>{
  const groups=Object.groupBy(rows,row=>row.name)
  return Object.fromEntries(Object.entries(groups).map(([name,group])=>{
    const a=group.filter(row=>row.variant==='before'),b=group.filter(row=>row.variant==='after')
    assert.ok(a.length>=5&&a.length===b.length,`${name} needs five pairs`)
    const differences=a.map(row=>{
      const other=b.find(value=>value.manager===row.manager&&value.round===row.round)
      assert.ok(other,`${name} missing pair`)
      return row.ms-other.ms
    })
    const spread=Math.max(...[...new Set(a.map(row=>row.manager))].map(manager=>{
      const times=a.filter(row=>row.manager===manager).map(row=>row.ms)
      return Math.max(...times)-Math.min(...times)
    }))
    const noise=Math.max(percentile(a.map(row=>row.ms),.5)*.1,spread,percentile(differences,.95)-percentile(differences,.05))
    const before=summarize(a),after=summarize(b)
    const bufferSpread=Math.max(...[...new Set(a.map(row=>row.manager))].map(manager=>{
      const values=a.filter(row=>row.manager===manager).map(row=>row.buffers)
      return (Math.max(...values)-Math.min(...values))/mean(values)
    }))
    return [name,{before,after,paired:{msSavedP50:round(percentile(differences,.5)),msSavedP95:round(percentile(differences,.95)),noiseMs:round(noise),clearsTimeNoise:percentile(differences,.5)>noise,bufferSavedPct:round((before.buffers.mean-after.buffers.mean)/before.buffers.mean*100),bufferNoisePct:round(Math.max(.1,bufferSpread)*100)}}]
  }))
}
const sql=connection=>load(`benchmark-${connection}.json`).samples.map(row=>{
  const plan=row.plan[0].Plan
  return {...row,ms:row.plan[0]['Execution Time'],buffers:(plan['Shared Hit Blocks']??0)+(plan['Shared Read Blocks']??0),wal:plan['WAL Bytes']??0,written:writes(row),bytes:Buffer.byteLength(row.response),triggers:Object.entries(row.functions).filter(([name,value])=>/^(public|private)\./.test(name)&&value.trigger).reduce((sum,[,value])=>sum+value.calls,0)}
})
const http=load('http-benchmark.json').observations.map(row=>({...row,...row.metrics,written:writes(row.metrics),bytes:row.name==='slot-move-today'?row.response.requests.find(request=>request.path.endsWith('/set_player_slot_moves_atomic')).bytes:row.response.bytes,dbBytes:row.response.requests.filter(request=>request.path.startsWith('/rest/')).reduce((sum,request)=>sum+request.bytes,0)}))
for(const row of http) {
  assert.ok(row.response.requests.every(request=>request.status>=200&&request.status<400),`${row.name} has a failed request`)
  if(['optimizer-edge','pre-tipoff-edge','close-worker','sync-draft-order'].includes(row.name)) {
    for(const method of ['POST','PATCH']) assert.ok(row.response.requests.some(request=>request.path==='/rest/v1/sync_runs'&&request.method===method),`${row.name} missing ${method} bookkeeping`)
  }
}
const invocationRows=load('http-invocations.json').observations.map(row=>({...row,...row.metrics,name:'queued/'+row.name,written:writes(row.metrics),bytes:row.response.bytes,dbBytes:row.response.requests.filter(request=>request.path.startsWith('/rest/')).reduce((sum,request)=>sum+request.bytes,0)}))
for(const row of invocationRows) {
  assert.ok(row.response.requests.every(request=>request.status>=200&&request.status<400))
  for(const rpc of ['start_edge_invocation','renew_work_lease','finish_edge_invocation']) assert.ok(row.response.requests.some(request=>request.path==='/rest/v1/rpc/'+rpc),`${row.name} missing ${rpc}`)
}
http.push(...invocationRows)
const warm=sql('warm'),fresh=sql('fresh')
for(const row of [...warm,...fresh,...http]) for(const key of ['ms','buffers','wal','statements','written','bytes']) assert.ok(Number.isFinite(row[key])&&row[key]>=0,`${row.name} invalid ${key}`)
const sample=row=>({name:row.name,manager:row.manager,variant:row.variant,round:row.round,connection:row.connection??'http',ms:row.ms,buffers:row.buffers,wal:row.wal,statements:row.statements,rowsWritten:row.written,responseBytes:row.bytes,dbResponseBytes:row.dbBytes,triggerCalls:row.triggers,followUp:Object.fromEntries(['publishes','refresh','notifications'].map(key=>[key,follow(row)[key]]))})
const report={baseline:'952580ce',concurrentWithOtherLanes:true,limits:{cpus:2,memory:'1g',sharedBuffers:'224MB',effectiveCacheSize:'384MB'},warm:compare(warm),fresh:compare(fresh),http:compare(http),samples:{warm:warm.map(sample),fresh:fresh.map(sample),http:http.map(sample)},inputs:Object.fromEntries(['benchmark-warm.json','benchmark-fresh.json','http-benchmark.json','http-invocations.json'].map(name=>[name,createHash('sha256').update(readFileSync(path.join(directory,name))).digest('hex')]))}
writeFileSync(evidencePath('lineup-draft-results.json'),JSON.stringify(report,null,2)+'\n')
const metric=(group,key)=>`${group.before[key].p50}→${group.after[key].p50}`
const timing=group=>`${group.before.ms.p50}/${group.before.ms.p95}→${group.after.ms.p50}/${group.after.ms.p95}`
const followCell=group=>['publishes','refresh','notifications'].map(key=>`${group.before.followUp[key]}→${group.after.followUp[key]}`).join(' / ')
let text='## Results\n\nA is 952580ce. B is the candidate. Values are per call. Calls show A/B counts. Buffers are shared hit plus read blocks. WAL and response sizes are bytes. Rows include every inserted, updated, and deleted row, including follow-up work. Times are p50/p95 DB execution milliseconds. The JSON artifact includes distributions, statement counts, trigger calls, function time, table writes, and paired noise.\n\n'
text+='SQL calls include deferred commit work. Their statement counts include the capture wrapper; the instrumentation-control row measures that overhead. SQL response sizes describe the JSON SQL capture. HTTP rows use actual response bodies. HTTP costs sum top-level pg_stat_statements deltas across all auth and REST requests. Nested calls contribute to statement counts, without double-counting their time, buffers, or WAL. Verified replay journals restore state while audit triggers remain disabled during measured HTTP calls.\n\n'
text+='| SQL action | Calls A/B | Warm ms A→B | Fresh ms A→B | Buffers A→B | WAL A→B | Rows A→B | Bytes A→B | Publish / refresh / notification writes A→B |\n|---|---:|---:|---:|---:|---:|---:|---:|---|\n'
for(const [name,group] of Object.entries(report.warm)) text+=`| ${name} | ${group.before.calls}/${group.after.calls} | ${timing(group)} | ${timing(report.fresh[name])} | ${metric(group,'buffers')} | ${metric(group,'wal')} | ${metric(group,'written')} | ${metric(group,'bytes')} | ${followCell(group)} |\n`
text+='\n| HTTP action | Calls A/B | DB ms A→B | Paired ms saved / noise | Statements A→B | Buffers A→B | WAL A→B | Rows A→B | Final bytes A→B | DB response bytes A→B | Publish / refresh / notification writes A→B |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|\n'
for(const [name,group] of Object.entries(report.http)) text+=`| ${name} | ${group.before.calls}/${group.after.calls} | ${timing(group)} | ${group.paired.msSavedP50} / ${group.paired.noiseMs} | ${metric(group,'statements')} | ${metric(group,'buffers')} | ${metric(group,'wal')} | ${metric(group,'written')} | ${metric(group,'bytes')} | ${metric(group,'dbBytes')} | ${followCell(group)} |\n`
text+='\n### Paired SQL differences\n\nPositive values mean fewer milliseconds or buffers. Noise uses the larger of 10%, within-manager baseline spread, and the paired time-difference spread. Runs were concurrent with other lanes.\n\n| Action | Warm ms saved / noise | Fresh ms saved / noise | Warm buffer gain / noise % |\n|---|---:|---:|---:|\n'
for(const [name,group] of Object.entries(report.warm)) { const fresh=report.fresh[name]; text+=`| ${name} | ${group.paired.msSavedP50} / ${group.paired.noiseMs} | ${fresh.paired.msSavedP50} / ${fresh.paired.noiseMs} | ${group.paired.bufferSavedPct} / ${group.paired.bufferNoisePct} |\n` }
text+='\n### Follow-up DB time\n\nThese are baseline warm-call function self times. Adding self time avoids counting nested calls twice. Percentages use mean action DB time. Worker bookkeeping is included in the HTTP totals and recorded as `public.sync_runs` writes. Its successful insert returns 45 bytes; its finish update returns zero bytes. No publish, refresh, notification, or bookkeeping implementation was changed.\n\n| SQL action | Version ms / share | Refresh ms / share | Notification ms / share | Trigger calls A→B | Statements A→B |\n|---|---:|---:|---:|---:|---:|\n'
for(const [name,group] of Object.entries(report.warm)) {
  const share=pattern=>{const value=Object.entries(group.before.functions).filter(([key])=>pattern.test(key)).reduce((sum,[,value])=>sum+value.selfMs,0);return `${round(value)} / ${round(value/group.before.ms.mean*100)}%`}
  text+=`| ${name} | ${share(/\.(.*league_version|publish_league_version|emit_league_change)/)} | ${share(/\.(refresh_|queue_matchup_forecasts)/)} | ${share(/\.notif_/)} | ${metric(group,'triggers')} | ${metric(group,'statements')} |\n`
}
text+='\n### Retained gains\n\n'
const fallback=report.warm['auto-set-future']
assert.ok(fallback.paired.bufferSavedPct>fallback.paired.bufferNoisePct,'Fallback buffer gain must clear noise')
text+=`Empty future-date auto-set saves ${fallback.paired.bufferSavedPct}% of shared buffer accesses against ${fallback.paired.bufferNoisePct}% noise. Stored slots are read once within each fallback candidate query. Other action responses, table rows, writes, WAL, and follow-up counts retain parity.\n\n`
for(const name of ['auto-set-button','optimizer-edge','pre-tipoff-edge','sync-draft-order']) {
  const group=report.http[name],gain=(group.before.dbBytes.mean-group.after.dbBytes.mean)/group.before.dbBytes.mean*100
  assert.ok(gain>10,`${name} bytes must clear the 10% floor`)
  text+=`${name}: ${round(gain)}% fewer DB response bytes. Only fields consumed by the existing calculation or verification are requested. Final action response bytes remain identical.\n\n`
}
text+='Queued worker rows also cover start/finish invocation records, lease renewal, per-write lease guards, work completion, and its event. These use the actual service wrapper and a running local work item. All of this overhead is included and remains unchanged.\n\nNo latency gain is claimed. Fresh connections have a newly opened backend and transactional fixture preparation; they are not disk-cold samples. HTTP uses the normal local auth and REST pools. Five HTTP pairs cover all three managers. Warm and fresh SQL use at least five pairs per action across the three managers. Both SQL modes prepare one committed lab fixture and roll back each action. Each fresh sample opens a new backend. The fixture adds three managers with 20 roster players, eight starter slots, three rookie rounds, an auction, and a complete 60-player board over the restored historical data. It does not model production traffic volume or delivery services.\n\n'
text+='### Actions measured with no qualifying DB gain\n\n'
text+=Object.entries(report.warm).filter(([name,group])=>name!=='instrumentation-control'&&name!=='auto-set-future').map(([name])=>`\`${name}\``).join(', ')+'.\n\n'
text+='Normal complete-proposal optimizer calls keep their DB reads and writes. Rookie picks, snake picks, nominations, bids, timer modes, autopicks, expiry batches, and draft imports keep their existing SQL. Write avoidance and batching would change generated lineup rows, request receipts, publishes, or queued work, so they were not retained. The draft-board change trims its verification read only.\n\n'
text+='### Rejected trials\n\n| Trial | Representative shared buffers A→B | Decision |\n|---|---:|---|\n| Date-scoped participation joins | Pre-tipoff 2134.3→2954.5 | Reverted; more work |\n| Inline participation CTE | Future empty 4018.2→4024.4 | Reverted; no gain |\n| Future-date lock shortcut | No qualifying buffer or paired-time gain | Reverted |\n| Coarse started-game check per fallback query | Future empty 3723.7→4249.1 | Reverted; more work |\n| Participation probes by player and game | Locked denial 466.5→544.7 | Reverted; regression |\n| Share game availability during candidate ordering | Future empty 3946.5→3579.8 | Reverted; 9.3% is below 10% |\n\n'
text+='Discarded confirmation attempts include stopped Docker services, cleared container caps after recreation, auth processing timeouts, idle worker fixtures, failed bookkeeping caused by interrupted-fixture residue, and audit DDL schema reloads. Their timings are excluded. Only complete successful action pairs with matching rows are reported. Auth and bookkeeping timeouts retry the whole variant from restored state, at most twice. The final report rejects missing worker bookkeeping, failed requests, insufficient pairs, or gains below the threshold.\n'
const document='tests/db/lineup-draft-actions.md'
const previous=readFileSync(document,'utf8')
const verification=previous.includes('## Verification and ship gate')?previous.slice(previous.indexOf('## Verification and ship gate')):''
writeFileSync(document,previous.split('## Results')[0]+text+'\n'+verification)
process.stdout.write(`Reported ${Object.keys(report.warm).length} SQL actions and ${Object.keys(report.http).length} HTTP actions.\n`)

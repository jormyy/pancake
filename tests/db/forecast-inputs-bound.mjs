import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

function timingSummary(samples) {
  const groups = Map.groupBy(samples, row => `${row.matchup_id}/${row.kind}`)
  return [...groups].map(([key, rows]) => {
    const ordered = rows.map(row => Number(row.milliseconds)).sort((a,b)=>a-b)
    return { key, calls:rows.length, p95:ordered[Math.ceil(ordered.length*0.95)-1], maximum:ordered.at(-1),
      sharedHit:Math.max(...rows.map(row=>Number(row.shared_hit))), sharedRead:Math.max(...rows.map(row=>Number(row.shared_read))) }
  })
}

export function enforceTiming(samples, plans=[]) {
  for (const row of timingSummary(samples)) {
    assert.ok(row.p95<300, `Forecast p95 exceeds 300 ms: ${JSON.stringify(row)}`)
    assert.ok(row.maximum<1000, `Forecast call exceeds 1 s: ${JSON.stringify(row)}`)
  }
  for (const plan of plans) assert.ok(plan.milliseconds<1000, `Forecast statement exceeds 1 s: ${plan.query}`)
}

export function nestedPlans(stderr) {
  const plans=[]
  const pattern=/duration: ([\d.]+) ms\s+plan:\s*/g
  for (const match of stderr.matchAll(pattern)) {
    const start=match.index+match[0].length
    let depth=0,quoted=false,escaped=false,end=start
    for (;end<stderr.length;end++) {
      const c=stderr[end]
      if (quoted) { if (escaped) escaped=false; else if (c==='\\') escaped=true; else if (c==='"') quoted=false }
      else if(c==='"') quoted=true
      else if(c==='{') depth++
      else if(c==='}' && --depth===0) { end++; break }
    }
    const value=JSON.parse(stderr.slice(start,end))
    plans.push({milliseconds:Number(match[1]),query:value['Query Text'],sharedHit:value.Plan['Shared Hit Blocks']??0,
      sharedRead:value.Plan['Shared Read Blocks']??0,plan:value})
  }
  return plans
}

function main() {
  const {values}=parseArgs({options:{phase:{type:'string'},output:{type:'string'},baseline:{type:'string'},samples:{type:'string',default:'30'},statistics:{type:'string',default:'current'},original:{type:'string'}}})
  assert.ok(['before','after'].includes(values.phase))
  assert.ok(values.output)
  assert.ok(['current','stale'].includes(values.statistics))
  const target=new URL(process.env.SUPABASE_DB_URL)
  assert.equal(target.hostname,'127.0.0.1')
  assert.equal(target.port,'61722')
  assert.equal(target.username,'supabase_admin')
  assert.equal(target.pathname,'/postgres')
  assert.ok(['postgres:', 'postgresql:'].includes(target.protocol) && !target.search && !target.hash)
  const cpu=spawnSync('docker',['inspect','supabase_db_pt4bafablefi','--format','{{.HostConfig.NanoCpus}}'],{encoding:'utf8'})
  assert.equal(cpu.status,0,cpu.stderr)
  assert.equal(cpu.stdout.trim(),'1000000000','Postgres must run with docker --cpus=1')
  const runs=[]
  const plans=[]
  for(const clock of ['2026-10-27T23:00:00Z','2026-10-28T23:00:00Z']) {
    for(const mode of ['force_custom_plan','force_generic_plan']) {
      const result=spawnSync('psql',[target.href,'-XqAtv','ON_ERROR_STOP=1','-v',`clock=${clock}`,'-v',`plan_mode=${mode}`,
        ...(values.original?['-v',`original=${values.original}`]:[]),'-v',`samples=${values.samples}`,'-v',`statistics=${values.statistics}`,'-v',`guard=${values.phase==='after'?'on':'off'}`,'-f','tests/db/forecast-inputs-bound.sql'],
      {encoding:'utf8',maxBuffer:128*1024*1024,timeout:1200000})
      writeFileSync(`${values.output}.${clock.slice(0,10)}.${mode}.log`,result.stderr)
      assert.equal(result.status,0,result.stderr.slice(-8000))
      const run=JSON.parse(result.stdout.trim().split('\n').find(line=>line.startsWith('{')))
      runs.push(run)
      plans.push(...nestedPlans(result.stderr).map(plan=>({...plan,clock,mode})))
      console.log(JSON.stringify({clock,mode,calls:run.samples.length,maximum:Math.max(...run.samples.map(row=>row.milliseconds)),liveGames:run.liveGames}))
    }
  }
  const report={phase:values.phase,cpu:1,runs,plans}
  writeFileSync(values.output,`${JSON.stringify(report,null,2)}\n`,{mode:0o600})
  if(values.phase==='after') {
    assert.ok(values.baseline,'The original result snapshot is required')
    const before=JSON.parse(readFileSync(values.baseline,'utf8'))
    assert.deepEqual(runs.map(run=>run.parity),before.runs.map(run=>run.parity),'Forecast output must remain byte-identical')
    assert.ok(runs.some(run=>run.liveGames>0),'An in-progress game day is required')
    enforceTiming(runs.flatMap(run=>run.samples),plans)
  }
}

if(process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) main()

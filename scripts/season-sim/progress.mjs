import assert from'node:assert/strict'
import{createHash}from'node:crypto'
import{readFile,readdir,mkdir,realpath,writeFile}from'node:fs/promises'
import{homedir}from'node:os'
import path from'node:path'
import{criteria}from'./criteria.mjs'

const value=(object,key)=>key.split('.').reduce((row,part)=>row?.[part],object)
const pass=row=>row?.passed===true||row?.status==='PASS'
const years=[2025,2026]
const everyYear=(rows,check)=>years.map(year=>rows.some(row=>row.year===year&&check(row)))

function witness(key,run,exports){
  const feature=(kind,labels)=>years.flatMap(year=>labels.map(label=>exports.find(row=>row.file===`${kind}-${year}-${label}.json`)))
  const flags=(...names)=>names.map(name=>value(run,name)===true)
  const waiver=name=>(run.waivers??[]).some(row=>row.name===name&&row.checked&&row.result?.passed)
  switch(key){
    case'full-run':return[run.complete===true,run.fullAcceptance===true,run.source?.committedHarness===true,run.freshDatabase===true,!run.failure&&!(run.failures?.length)]
    case'production-dispatch':return flags('triggerFidelity.verified')
    case'real-inputs':return[(run.days??[]).reduce((sum,day)=>sum+(day.finals?.games??0),0)===1230,(run.nextSeasonProgress?.days??[]).reduce((sum,day)=>sum+(day.finals?.games??0),0)===1230]
    case'rollover':return flags('rolloverHistory.passed','waiverRollover.passed','seasonEnd.historyPreserved')
    case'live':return flags('realtime.passed','realtimeSecond.passed').concat(run.liveSamples>0)
    case'weekly':return[(run.days??[]).some(row=>row.weekly?.length>0),(run.nextSeason?.checked?.length??0)>1]
    case'playoffs':return flags('seasonEnd.passed','secondSeasonEnd.passed')
    case'champion':return flags('champion.passed','secondChampion.passed')
    case'trade-deadline':return flags('actions.tradeDeadline.postDeadlinePassed','tradingReopened.passed')
    case'rookie-draft':return[run.realDraftBoard?.passed===true,run.rookieAutoPick?.passed===true,(run.seasonEnd?.rookiePicks??0)>0]
    case'picks':return flags('pickAllocation.passed','offseasonTrade.passed','nextSeason.historyPreserved')
    case'faab':return[waiver('season-one-faab')]
    case'rolling':return[waiver('skipped-week-rolling'),waiver('eligible-week-rolling')]
    case'limits':return[waiver('season-one-faab'),waiver('eligible-week-rolling'),run.waiverRollover?.passed===true,(run.allStarLimits??[]).length===2]
    case'skipped':return flags('nextSeason.passed').concat((run.nextSeason?.checked??[]).includes(2))
    case'opening':return flags('firstCalendar.passed','secondCalendar.passed')
    case'cup':return[(run.firstCalendar?.cupFinalsExcluded??[]).length===1,(run.secondCalendar?.cupFinalsExcluded??[]).length===1]
    case'rookie-identity':return flags('realRookieCoverage.passed')
    case'rookie-actions':return flags('realRookieActions.trade.passed','realRookieActions.bench.measured','realRookieActions.readd.passed')
    case'nba-trades':return everyYear(run.nbaTrades??[],row=>row.passed)
    case'postponements':return[new Set((run.realInputChecks??[]).flatMap(day=>(day.postponements??[]).filter(row=>day.date>=(run.inputPostponements??[]).find(input=>input.id===row.gameId)?.makeupDate).map(row=>row.gameId))).size>=6]
    case'allstar':return flags('firstCalendar.passed','secondCalendar.passed')
    case'allstar-policy':return[(run.allStarLimits??[]).length===2&&(run.allStarLimits??[]).every(row=>row.passed)]
    case'F1':return feature('F1',['week-1','mid-season','final'])
    case'F2-fit':return feature('F2',['week-1','final']).map(row=>row?.fit===true||row?.fitStatus==='PASS')
    case'F2-seeds':return feature('F2',['final']).map(row=>row?.status==='FAILED'?row:row?.champions===1&&row?.passed===true)
    case'F3':return[...feature('F3',['opening-before-played','after-first-final']),exports.find(row=>row.file==='F3-2026-preseason.json')]
    case'F3-fallback':return[exports.find(row=>row.file==='F3-2026-preseason.json')?.withStats>0]
    case'timer-pause':return[(run.rookiePause??[]).length>0&&(run.rookiePause??[]).every(row=>row.passed)]
    case'F6-turns':return[exports.find(row=>row.file==='F6-rookie-picks.json')]
    default:{
      if(key.startsWith('postponement:')){
        const id=key.slice('postponement:'.length),timeline=(run.inputPostponements??[]).find(row=>row.id===id)
        return[!!timeline&&(run.realInputChecks??[]).some(day=>day.date>=timeline.makeupDate&&(day.postponements??[]).some(row=>row.gameId===id&&row.passed))]
      }
      return[]
    }
  }
}

export function criterionStatus(row,observed,supplemental=[],laneEvidence=[]){
  if(row.pinnedFailure)return'FAILED'
  if(row.proof==='full-run'&&(observed.run.failure||observed.run.fatalExit||observed.run.failures?.length))return'FAILED'
  if(row.route==='supplemental'){
    const found=supplemental.filter(record=>record.id===row.id)
    return found.some(record=>record.passed===false)?'FAILED':found.length>=2&&found.every(record=>record.passed)?row.proof==='smoke'?'PARTIAL':'PASS':found.length?'PARTIAL':'PENDING'
  }
  if(row.route!=='replay'){
    const proof=laneEvidence.find(item=>item.criteria.includes(row.id))
    if(proof?.commands?.length>=2&&proof.commands.every(command=>command.exit===0)&&proof.sourceManifestSha256)return'LANE EVIDENCE'
    return row.gap?'GAP':'LANE RECIPE'
  }
  const evidence=witness(row.proof,observed.run,observed.exports)
  if(evidence.some(item=>item?.status==='FAILED'))return'FAILED'
  const passed=evidence.map(item=>item===true||pass(item))
  if(passed.length&&passed.every(Boolean))return row.fullRunOnly&&!observed.run.fullAcceptance?'PARTIAL':'PASS'
  return passed.some(Boolean)?'PARTIAL':'PENDING'
}

export function estimateCriterion(row,run,now){
  const target=row.expected.at(-1)?.date
  if(!target)return{at:null,reason:'Not scheduled in the protected replay'}
  if(run.failure||run.fatalExit)return{at:null,reason:'Replay has failed; no automatic continuation assumed'}
  const completed=[...(run.days??[]),...(run.nextSeasonProgress?.days??[])],samples=completed.map(day=>day.wallSeconds).filter(seconds=>seconds>0)
  if(!samples.length)return{at:null,reason:'No completed measured date yet'}
  const phase=run.phase??'',current=/^\d{4}-\d{2}-\d{2}/.exec(phase)?.[0]??completed.at(-1)?.date
  if(!current)return{at:null,reason:'Business date unavailable'}
  const remaining=Math.ceil((Date.parse(target+'T12:00Z')-Date.parse(current+'T12:00Z'))/86400000)+1
  if(remaining<=0)return{at:null,reason:'Expected business phase passed; missing proof is not acceptance'}
  const mean=samples.reduce((sum,seconds)=>sum+seconds,0)/samples.length
  const model='Uniform business-date extrapolation from completed active dates; unmeasured idle cadence can differ'+(run.failures?.length?'; data collection only, acceptance already has failures':'')
  return{at:new Date(now+remaining*mean*1000).toISOString(),earliest:new Date(now+remaining*Math.min(...samples)*1000).toISOString(),latest:new Date(now+remaining*Math.max(...samples)*1000).toISOString(),remainingBusinessDates:remaining,secondsPerDate:mean,samples:samples.length,model}
}

export function summarizeProgress(observed,{now=Date.now(),supplemental=[],laneEvidence=[]}={}){
  return{capturedAt:new Date(now).toISOString(),scope:'Read-only observations. Projections are not deadlines or measured completion.',phase:observed.progress?.phase??observed.run.phase,acceptanceBlocked:!!(observed.run.failure||observed.run.fatalExit||observed.run.failures?.length),checkpointSavedAt:observed.run.savedAt??null,observationLagSeconds:Number.isFinite(Date.parse(observed.run.savedAt))?Math.max(0,(now-Date.parse(observed.run.savedAt))/1000):null,observedSource:observed.run.source??null,readFiles:observed.files??[],completedDates:(observed.run.days??[]).length+(observed.run.nextSeasonProgress?.days??[]).length,readErrors:observed.errors??[],criteria:criteria.map(row=>({...row,status:criterionStatus(row,observed,supplemental,laneEvidence),eta:estimateCriterion(row,observed.run,now)}))}
}

export async function readProgress(input){
  assert.ok(path.isAbsolute(input))
  const errors=[],files=[]
  const read=async name=>{
    try{const text=await readFile(path.join(input,name),'utf8');const parsed=JSON.parse(text);files.push({file:name,sha256:createHash('sha256').update(text).digest('hex')});return parsed}
    catch(error){if(error.code!=='ENOENT')errors.push({file:name,message:error.message});return null}
  }
  const progress=await read('replay-progress.json'),checkpoint=await read('replay-checkpoint.json'),final=await read('final-run.json'),exit=await read('exit.json')
  const exports=[]
  for(const name of(await readdir(input)).filter(name=>/^F[1236]-[\w-]+\.json$/.test(name))){const data=await read(name);if(data)exports.push({...data,file:name})}
  const run={...(checkpoint??{}),...(final??{})}
  run.fatalExit=exit?.exit===1
  if(final?.fullAcceptance&&exit?.exit===0)run.fullAcceptance=true
  else run.fullAcceptance=false
  return{run,progress,exports,exit,errors,files}
}

export async function assertOutput(input,output,allowed=path.join(homedir(),'pancake-t_4ba51e0d/lanes/sim-supp/evidence/r11')){
  assert.ok(output&&path.isAbsolute(output),'An absolute separate output directory is required')
  const target=path.resolve(output),root=path.resolve(allowed),source=await realpath(input)
  assert.ok(target===root||target.startsWith(root+'/'),'Output belongs only to the supplemental evidence directory')
  assert.ok(!target.startsWith(source+'/')&&target!==source,'The observed evidence directory is read-only')
  let ancestor=target
  for(;;){try{assert.equal(await realpath(ancestor),ancestor,'Output cannot pass through a symlink');break}catch(error){if(error.code!=='ENOENT')throw error;ancestor=path.dirname(ancestor)}}
  return target
}

export async function writeProgress({input,output}){
  const directory=await assertOutput(input,output)
  const observed=await readProgress(input)
  let supplemental=[]
  try{supplemental=JSON.parse(await readFile(path.join(directory,'supplemental-results.json'),'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
  let laneEvidence=[]
  try{laneEvidence=JSON.parse(await readFile(path.join(directory,'lane-evidence.json'),'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
  let pinnedInventory=null
  try{pinnedInventory=JSON.parse(await readFile(path.join(directory,'event-inventory-pinned.json'),'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
  const base=summarizeProgress(observed,{supplemental,laneEvidence})
  const enriched=base.criteria.map(row=>({...row,laneProof:laneEvidence.find(proof=>proof.criteria.includes(row.id))??null,eventInventory:pinnedInventory?.records?.find(event=>row.id==='event:'+event.event_key)??null}))
  const report={...base,pinnedInventory,laneEvidence,criteria:enriched}
  await mkdir(directory,{recursive:true})
  await writeFile(path.join(directory,'criteria.json'),JSON.stringify(report,null,2)+'\n')
  const cell=value=>String(value??'').replaceAll('|','/').replaceAll('\n',' ')
  const lines=['# Acceptance criteria','',report.scope,'','Bare module paths mean scripts/season-sim. ../evidence and ../briefs refer to the task workspace on the main Mac. Later lane recipes can be absent from the protected candidate.','',`Captured: ${report.capturedAt}; phase: ${report.phase}; completed dates: ${report.completedDates}.`,'','| Criterion / brief line | Status | Evidence / oracle | Business phase | Projected UTC ETA | Full run only | Gap / pinned producer evidence |','| --- | --- | --- | --- | --- | --- | --- |',...report.criteria.map(row=>`| ${cell(row.id+(row.features.length?' ['+row.features.join(',')+']':'')+' / '+row.briefLines.join(','))}: ${cell(row.name)} | ${row.status} | ${cell(row.paths.join('; '))} | ${cell(row.expected.map(item=>item.date+' '+item.phase).join('; '))} | ${cell(row.eta.at??row.eta.reason)} | ${row.fullRunOnly?'yes':'no'} | ${cell([row.gap,row.eventInventory?.producer,row.eventInventory?.test_name,row.eventInventory?.status,row.laneProof?.handoff].filter(Boolean).join('; '))} |`),'','ETA model: completed active-date wall times extrapolated to remaining business dates. Offseason throughput is not yet measured.','Transport note: normal-run one-send observations are not an exactly-once delivery guarantee.']
  await writeFile(path.join(directory,'criteria.md'),lines.join('\n')+'\n')
  for(const row of report.criteria)console.log(`${row.id}: ${row.status}; ETA ${row.eta.at??row.eta.reason}`)
  return report
}

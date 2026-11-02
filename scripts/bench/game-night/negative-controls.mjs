import assert from 'node:assert/strict'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { directory, id, json, readJson, repository } from './common.mjs'
import { finalCheck } from './measure.mjs'
import { startStack } from './stack.mjs'
import { configurePool } from './pool.mjs'
import { runWindow } from './experiment.mjs'

export async function proveDroppedFinal(stack,slate,report) {
  assert.ok(report.passed && report.workCounts.passed,'The final-stat control requires a passing replay')
  const before=await finalCheck(stack,slate,report.seconds)
  assert.ok(before.passed,'The unmodified final state must pass')
  const deleted=await stack.sql(`DELETE FROM public.player_game_stats WHERE game_id='${id(800003)}' AND player_id='${id(1081)}' RETURNING id`)
  assert.ok(deleted,'The final-stat control must delete one existing stat')
  const after=await finalCheck(stack,slate,report.seconds)
  assert.equal(after.passed,false,'A missing final stat must fail')
  const result={control:'delete one stored final stat after a passing replay',source:report.source,grader:report.grader,
    positiveReport:report.label,workCounts:report.workCounts,controlBefore:before,finalState:after,passed:false,expectedFailure:true}
  await json(path.join(stack.evidence,'control-broken-final.json'),result)
  return result
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const {values}=parseArgs({options:{evidence:{type:'string'},limits:{type:'string'},source:{type:'string',default:repository},
    pool:{type:'string',default:'2'},'shared-buffers':{type:'string'}}})
  assert.ok(values.evidence && values.limits,'Evidence and frozen action limits are required')
  const slate=await readJson(path.join(directory,'training.json'))
  let stack
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{
    try{await stack?.stop()}finally{process.exit(130)}
  })
  try {
    stack=await startStack(values.evidence,{sourceRoot:values.source,sharedBuffers:values['shared-buffers']})
    stack.qualityEnabled=true
    stack.phoneLab=true
    stack.liveArchitecture=true
    stack.policyChecks=true
    const limits=await readJson(values.limits)
    stack.qualityOptions={limits}
    stack.runtimeConfiguration={postgrest:await configurePool(stack,{connections:Number(values.pool)})}
    const off=await runWindow(stack,slate,{label:'control-ingestion-off',memoryMiB:192,seconds:120,ingestionOff:true})
    assert.equal(off.workCounts.passed,false)
    assert.equal(off.workCounts.saved,0)
    assert.ok(off.workCounts.cronRuns>0,'The disabled-ingestion control must retain background work')
    stack.qualityOptions={limits,fault:'slow-actions,realtimeScores,forecastDelivery,phone-refresh,phone-final,phone-stale'}
    const broken=await runWindow(stack,slate,{label:'control-quality',memoryMiB:192,skipSettlement:true})
    for(const name of ['rosterMove','lineupSave','tradeOffer','tradeAccept','waiverResult','realtimeScores','forecastDelivery','scoreFreshness'])
      assert.equal(broken.quality.gates[name].passed,false,`${name} must reject its fault`)
    for(const name of ['invalidation','finalScores','freshness'])
      assert.equal(broken.phones.gates[name].passed,false,`${name} must reject its fault`)
    await json(path.join(values.evidence,'controls-summary.json'),{passed:true,ingestionOff:off.workCounts,
      quality:broken.quality,phones:broken.phones.gates,
      scope:'Combined full-stack fault injection; individual gate independence also has focused negative tests.'})
    console.log('All named ingestion, action, forecast, Realtime, and phone faults are rejected.')
  } finally {await stack?.stop()}
}

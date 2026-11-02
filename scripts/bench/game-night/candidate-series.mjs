import assert from 'node:assert/strict'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {readFile} from 'node:fs/promises'
import {directory,repository,json,readJson,digest} from './common.mjs'
import {waitForFixtureDay} from './calendar.mjs'
import {startStack} from './stack.mjs'
import {configurePool} from './pool.mjs'
import {runWindow} from './experiment.mjs'
import {isolatedReplay} from './isolated-series.mjs'
import {proveDroppedFinal} from './negative-controls.mjs'
import {compareRecordedReference} from './series.mjs'

const {values}=parseArgs({options:{help:{type:'boolean'},source:{type:'string',default:repository},reference:{type:'string'},limits:{type:'string'},evidence:{type:'string'},pool:{type:'string',default:'2'},'shared-buffers':{type:'string',default:'32MB'},ceiling:{type:'string',default:'35.09'}}})
if(values.help) {
  console.log('Usage: node scripts/bench/game-night/candidate-series.mjs --source PATH --reference SUMMARY --limits FILE --evidence PATH [--ceiling 35.09]\nRuns three unpaired candidates with every quality and Free-plan gate. It never runs a reference stack.')
} else {
  assert.ok(values.reference && values.limits && values.evidence,'Recorded reference, action limits, and external evidence are required')
  assert.ok(path.relative(repository,path.resolve(values.evidence)).startsWith('..'),'Evidence must remain outside the repository')
  const baseline=await readJson(values.reference),limits=await readJson(values.limits)
  await waitForFixtureDay({duration:3*60*60*1000})
  const slate=await readJson(path.join(directory,'training.json'))
  await json(path.join(values.evidence,'reference.json'),{file:path.resolve(values.reference),sha256:digest(await readFile(values.reference)),summary:baseline,paired:false})
  const reports=[]
  let active
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{try{await active?.stop()}finally{process.exit(130)}})
  for(let number=1;number<=3;number++) {
    const label=`candidate-${number}`
    const report=await isolatedReplay(async attempt=>{
      let stack
      try {
        stack=active=await startStack(path.join(values.evidence,`${label}-attempt-${attempt}`),{sourceRoot:values.source,sharedBuffers:values['shared-buffers']})
        stack.qualityEnabled=true;stack.phoneLab=true;stack.liveArchitecture=true;stack.policyChecks=true
        stack.qualityOptions={limits}
        stack.runtimeConfiguration={postgrest:await configurePool(stack,{connections:Number(values.pool)})}
        const result=await runWindow(stack,slate,{label,memoryMiB:192})
        if(number===3 && result.passed)await json(path.join(values.evidence,'control-broken-final.json'),await proveDroppedFinal(stack,slate,result))
        return result
      } finally {await stack?.stop();active=null}
    })
    await json(path.join(values.evidence,`${label}.json`),report)
    assert.ok(report.passed,`${label} fails quality`)
    const budget=report.projectedBudget
    assert.ok(budget?.supabaseWithinAcceptedRiskLimits && budget.supabaseQuarterTargets && budget.vercelWithinHalfLimits && budget.vercelInvocationTarget,`${label} fails the Free-plan gate`)
    reports.push(report)
    console.log(`${label} accepted: ${report.resources.primary.value} anonymous refaults/s`)
  }
  const comparison=compareRecordedReference(baseline,reports,{limits,targetCeiling:Number(values.ceiling)})
  await json(path.join(values.evidence,'candidate-summary.json'),comparison.candidate)
  await json(path.join(values.evidence,'action-limits.json'),limits)
  await json(path.join(values.evidence,'comparison.json'),comparison)
  assert.ok(comparison.passed,'The candidate-only comparison fails its final bar')
  console.log(JSON.stringify({paired:false,passed:true,median:comparison.candidate.metrics.cgroupAnonRefaultsPerSecond.median}))
}

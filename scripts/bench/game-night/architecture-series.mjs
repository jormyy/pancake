import assert from 'node:assert/strict'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { appendFile } from 'node:fs/promises'
import { directory, json, readJson, repository } from './common.mjs'
import { startStack } from './stack.mjs'
import { configurePool } from './pool.mjs'
import { runWindow } from './experiment.mjs'
import { actionLimits, compareSeries } from './series.mjs'
import { isolatedReplay } from './isolated-series.mjs'
import { proveDroppedFinal } from './negative-controls.mjs'

const { values }=parseArgs({options:{
  evidence:{type:'string',default:'/Users/michaelchen/Documents/pancake-half-gig/evidence-climb/architecture-series'},
  baseline:{type:'string',default:path.resolve(repository,'../half-gig-baseline')},
  candidate:{type:'string',default:repository},
  'shared-buffers':{type:'string'},
  pool:{type:'string',default:'2'},
  'worker-overlay':{type:'string',multiple:true},
}})
const slate=await readJson(path.join(directory,'training.json'))
const baselines=[],candidates=[]
let activeStack
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{
  try {await activeStack?.stop()}finally {process.exit(signal==='SIGINT'?130:143)}
})
for(const [variant,number] of [['baseline',1],['architecture',1],['architecture',2],['baseline',2],['baseline',3],['architecture',3]]) {
  const label=`${variant}-${number}`
  const report=await isolatedReplay(async attempt=>{
    let stack
    try {
      stack=activeStack=await startStack(path.join(values.evidence,`${label}-attempt-${attempt}`),{sourceRoot:variant==='baseline'?values.baseline:values.candidate,functionOverlays:values['worker-overlay'] ?? [],
        ...(variant!=='baseline' && values['shared-buffers']?{sharedBuffers:values['shared-buffers']}:{})})
      stack.qualityEnabled=true
      stack.phoneLab=true
      stack.liveArchitecture=variant!=='baseline'
      stack.policyChecks=variant!=='baseline'
      stack.qualityOptions=baselines.length>=3?{limits:actionLimits(baselines)}:{}
      stack.runtimeConfiguration={postgrest:await configurePool(stack,variant==='baseline'?{}:{connections:Number(values.pool)})}
      const report=await runWindow(stack,slate,{label,memoryMiB:192})
      if(variant==='architecture' && number===3 && report.passed)
        await json(path.join(values.evidence,'control-broken-final.json'),await proveDroppedFinal(stack,slate,report))
      return report
    } finally {await stack?.stop();activeStack=null}
  })
  await json(path.join(values.evidence,`${label}.json`),report)
  assert.ok(report.passed,`${label} fails its required checks`)
  ;(variant==='baseline'?baselines:candidates).push(report)
  console.log(`${label} complete; ${baselines.length} baseline and ${candidates.length} candidate runs accepted.`)
}
const comparison=compareSeries(baselines,candidates)
await json(path.join(values.evidence,'baseline-summary.json'),comparison.baseline)
await json(path.join(values.evidence,'candidate-summary.json'),comparison.candidate)
await json(path.join(values.evidence,'action-limits.json'),comparison.limits)
await json(path.join(values.evidence,'comparison.json'),comparison)
await appendFile('/Users/michaelchen/Documents/pancake-half-gig/ROUND-LOG.md',`\n## Public live architecture, paired series\nBaseline: ${comparison.baseline.metrics.cgroupAnonRefaultsPerSecond.median} anon refaults/s, n=3. Baseline quality passed: ${comparison.baselineQualityPassed}; failed reference reports remain failed. Candidate: ${comparison.candidate.metrics.cgroupAnonRefaultsPerSecond.median} anon refaults/s, n=3. Noise: ${comparison.noisePagesPerSecond} anon refaults/s. Gain: ${comparison.gainFraction*100}%. Quality: ${comparison.quality}. Target: ${comparison.trainingTarget}. Evidence: ${values.evidence}.\n`)
console.log(JSON.stringify({baseline:comparison.baseline.metrics.cgroupAnonRefaultsPerSecond,candidate:comparison.candidate.metrics.cgroupAnonRefaultsPerSecond,gain:comparison.gainFraction,quality:comparison.quality,passed:comparison.passed}))

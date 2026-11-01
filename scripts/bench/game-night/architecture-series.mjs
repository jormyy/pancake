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

const { values }=parseArgs({options:{
  evidence:{type:'string',default:'/Users/michaelchen/Documents/pancake-half-gig/evidence-climb/architecture-series'},
  baseline:{type:'string',default:path.resolve(repository,'../half-gig-baseline')},
  candidate:{type:'string',default:repository},
  'shared-buffers':{type:'string'},
  pool:{type:'string',default:'2'},
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
      stack=activeStack=await startStack(path.join(values.evidence,`${label}-attempt-${attempt}`),{sourceRoot:variant==='baseline'?values.baseline:values.candidate,
        ...(variant!=='baseline' && values['shared-buffers']?{sharedBuffers:values['shared-buffers']}:{})})
      stack.qualityEnabled=true
      stack.phoneLab=true
      stack.liveArchitecture=variant!=='baseline'
      stack.policyChecks=variant!=='baseline'
      stack.qualityOptions=baselines.length>=3?{limits:actionLimits(baselines)}:{}
      stack.runtimeConfiguration={postgrest:await configurePool(stack,variant==='baseline'?{}:{connections:Number(values.pool)})}
      const report=await runWindow(stack,slate,{label,memoryMiB:192})
      return report
    } finally {await stack?.stop();activeStack=null}
  })
  await json(path.join(values.evidence,`${label}.json`),report)
  assert.ok(report.passed,`${label} fails a quality gate`)
  ;(variant==='baseline'?baselines:candidates).push(report)
  console.log(`${label} complete; ${baselines.length} baseline and ${candidates.length} candidate runs accepted.`)
}
const comparison=compareSeries(baselines,candidates)
await json(path.join(values.evidence,'baseline-summary.json'),comparison.baseline)
await json(path.join(values.evidence,'candidate-summary.json'),comparison.candidate)
await json(path.join(values.evidence,'action-limits.json'),comparison.limits)
await json(path.join(values.evidence,'comparison.json'),comparison)
await appendFile('/Users/michaelchen/Documents/pancake-half-gig/ROUND-LOG.md',`\n## Public live architecture, paired series\nBaseline: ${comparison.baseline.metrics.swapTotalPagesPerSecond.median} pages/s, n=3. Candidate: ${comparison.candidate.metrics.swapTotalPagesPerSecond.median} pages/s, n=3. Noise: ${comparison.noisePagesPerSecond} pages/s. Gain: ${comparison.gainFraction*100}%. Quality: ${comparison.quality}. Target: ${comparison.trainingTarget}. Evidence: ${values.evidence}.\n`)
console.log(JSON.stringify({baseline:comparison.baseline.metrics.swapTotalPagesPerSecond,candidate:comparison.candidate.metrics.swapTotalPagesPerSecond,gain:comparison.gainFraction,quality:comparison.quality,passed:comparison.passed}))

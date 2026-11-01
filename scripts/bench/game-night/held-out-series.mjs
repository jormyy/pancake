import assert from 'node:assert/strict'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {directory,json,readJson} from './common.mjs'
import {startStack} from './stack.mjs'
import {configurePool} from './pool.mjs'
import {runWindow} from './experiment.mjs'
import {actionLimits} from './series.mjs'
import {summarize} from './summary.mjs'
import {isolatedReplay} from './isolated-series.mjs'

const {values}=parseArgs({options:{training:{type:'string'},baseline:{type:'string'},evidence:{type:'string'},pool:{type:'string',default:'2'},'shared-buffers':{type:'string'},'worker-overlay':{type:'string',multiple:true},'baseline-migration':{type:'string',multiple:true}}})
assert.ok(values.training && values.baseline && values.evidence,'Provide the passing training comparison, baseline checkout, and evidence directory')
const training=await readJson(values.training)
assert.ok(training.version==='game-night-comparison-v3' && training.passed && training.candidate.n>=3,'Training must pass before held-out is loaded')
const slate=await readJson(path.join(directory,'held-out.json'))
let stack
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await stack?.stop();process.exit(130)})
const baselines=[]
for(let number=1;number<=3;number++) {
  const report=await isolatedReplay(async attempt=>{
    try {
      stack=await startStack(path.join(values.evidence,`baseline-${number}-attempt-${attempt}`),{sourceRoot:path.resolve(values.baseline),functionOverlays:values['worker-overlay'] ?? [],migrationOverlays:values['baseline-migration'] ?? []})
      stack.phoneLab=true;stack.qualityEnabled=true
      stack.runtimeConfiguration={postgrest:await configurePool(stack,{})}
      return await runWindow(stack,slate,{label:`held-out-baseline-${number}`,memoryMiB:192})
    }finally{await stack?.stop();stack=null}
  })
  assert.ok(report.passed,'The held-out reference must pass')
  baselines.push(report)
}
const baseline=summarize(baselines,{reference:true})
const limits=actionLimits(baselines)
await json(path.join(values.evidence,'baseline-summary.json'),baseline)
let candidate
try {
  stack=await startStack(path.join(values.evidence,'candidate'),{sharedBuffers:values['shared-buffers'],functionOverlays:values['worker-overlay'] ?? []})
  stack.phoneLab=true;stack.qualityEnabled=true;stack.liveArchitecture=true;stack.policyChecks=true;stack.qualityOptions={limits}
  stack.runtimeConfiguration={postgrest:await configurePool(stack,{connections:Number(values.pool)})}
  candidate=await runWindow(stack,slate,{label:'held-out',memoryMiB:192})
}finally{await stack?.stop();stack=null}
const target=baseline.metrics.cgroupAnonRefaultsPerSecond.median*.05
const result={version:'game-night-held-out-v2',baseline,candidate,targetAnonRefaultsPerSecond:target,passed:candidate.passed && candidate.resources.primary.value<=target}
await json(path.join(values.evidence,'held-out-summary.json'),result)
assert.ok(result.passed,'Held-out fails its quality or cgroup target')

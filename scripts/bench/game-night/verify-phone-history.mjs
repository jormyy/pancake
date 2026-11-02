import path from 'node:path'
import { parseArgs } from 'node:util'
import { defaultEvidence, command, id, json, readJson, repository } from './common.mjs'
import { startStack } from './stack.mjs'
import { configurePool } from './pool.mjs'
import { prepare } from './experiment.mjs'
import { startWorkers } from './workers.mjs'
import { startPublicFeed } from './public-runtime.mjs'
import { verifyOfficialHistory } from './official-history.mjs'

const { values }=parseArgs({options:{evidence:{type:'string',default:path.join(defaultEvidence, 'official-history')}}})
let stack,prepared,workers,publicFeed
try {
  stack=await startStack(path.resolve(values.evidence))
  stack.qualityEnabled=true
  stack.phoneLab=true
  stack.liveArchitecture=true
  await configurePool(stack,{connections:2})
  prepared=await prepare(stack,await readJson(path.join(repository,'scripts/bench/game-night/training.json')),'history')
  publicFeed=await startPublicFeed(stack,'history')
  workers=await startWorkers(stack,'history')
  const response=await fetch(`http://127.0.0.1:${stack.ports.edge}/functions/v1/live-poll`,{method:'POST',headers:{'x-internal-function-token':stack.token},signal:AbortSignal.timeout(125000)})
  const warmup=await response.json()
  if(!response.ok || warmup.failures?.length)throw new Error('Official-history warmup failed')
  const result=await verifyOfficialHistory(stack,publicFeed)
  await json(path.join(stack.evidence,'report.json'),{...result,warmup,viewer:id(101),head:(await command('git',['rev-parse','HEAD'])).stdout.trim()})
  console.log(JSON.stringify(result))
} finally {
  await workers?.close()
  await publicFeed?.close()
  await prepared?.feed.close()
  await stack?.stop()
}

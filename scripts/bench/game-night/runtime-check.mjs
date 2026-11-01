import assert from 'node:assert/strict'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { command, directory, json, readJson } from './common.mjs'
import { startStack } from './stack.mjs'
import { configurePool } from './pool.mjs'
import { prepare } from './experiment.mjs'
import { startWorkers } from './workers.mjs'
import { startPublicFeed } from './public-runtime.mjs'
import { startPhones } from './phones.mjs'

const {values}=parseArgs({options:{evidence:{type:'string',default:'/Users/michaelchen/Documents/pancake-half-gig/evidence-climb/runtime-check'}}})
let stack,feed,workers,publicFeed,phones,switchTimer
try {
  stack=await startStack(path.resolve(values.evidence))
  stack.qualityEnabled=true
  stack.liveArchitecture=true
  await configurePool(stack,{connections:2})
  const prepared=await prepare(stack,await readJson(path.join(directory,'training.json')),'runtime')
  feed=prepared.feed
  publicFeed=await startPublicFeed(stack,'runtime')
  workers=await startWorkers(stack,'runtime')
  await command('docker',['update','--memory=192m','--memory-swap=1536m',stack.container])
  phones=await startPhones(stack,publicFeed)
  switchTimer=setTimeout(()=>{void publicFeed.control({disabled:true})},45000)
  const response=await fetch(`http://127.0.0.1:${stack.ports.edge}/functions/v1/live-poll`,{method:'POST',
    headers:{'x-internal-function-token':stack.token},signal:AbortSignal.timeout(125000)})
  const worker=await response.json()
  await phones.refresh()
  const clients=phones.snapshot()
  const result={passed:response.ok && worker.sourceModes?.includes('public') && worker.sourceModes?.includes('database')
      && clients.length===10 && clients.every(client=>client.ready && !client.error && client.broadcasts>0),
    worker,clients,publicFeed:await publicFeed.health()}
  await json(path.join(stack.evidence,'runtime-result.json'),result)
  console.log(JSON.stringify({passed:result.passed,modes:worker.sourceModes,phones:clients.length,broadcasts:clients.map(client=>client.broadcasts)}))
  assert.ok(result.passed,'The local public route, ten phones, and off switch must work together')
} finally {
  clearTimeout(switchTimer)
  await workers?.close()
  await phones?.close()
  await publicFeed?.close()
  await feed?.close()
  await stack?.stop()
}

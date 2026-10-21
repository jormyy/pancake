import assert from 'node:assert/strict'
import test from 'node:test'
import { trackWorkerWait,workerHealth } from './worker-waits.mjs'

test('health separates a harness callback, network headers and business waits',async()=>{
  const owner={id:1,function:'live-poll',invocation:'local-invocation',started:10,io:new Map()}
  let release=()=>{}
  const pending=trackWorkerWait(owner,'harness-sample','/__sim/live-sample',()=>new Promise(resolve=>{release=()=>resolve(null)}))
  const state=workerHealth(new Set([owner]),{inspect:()=>[{kind:'business-sleep',due:20000},{kind:'business-interval',due:15000}]},40)
  assert.equal(state[0].elapsedMs,30)
  assert.deepEqual(state[0].waits.map(row=>row.kind),['harness-sample','business-sleep','business-interval'])
  release();await pending;assert.equal(owner.io.size,0)
  await assert.rejects(trackWorkerWait(owner,'fetch-headers','/rest/v1/matchups',async()=>{throw new Error('failure')}))
  assert.equal(owner.io.size,0)
})

test('health request and wait lists are bounded',()=>{
  const rows=new Set(Array.from({length:100},()=>({io:new Map(Array.from({length:100},(_,i)=>[i,{kind:'fetch-headers'}])),started:0})))
  const health=workerHealth(rows,{},10)
  assert.equal(health.length,32)
  assert.ok(health.every(row=>row.waits.length===16))
})

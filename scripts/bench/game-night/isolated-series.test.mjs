import assert from 'node:assert/strict'
import test from 'node:test'
import { isolatedReplay } from './isolated-series.mjs'

test('a pressure-affected replay is preserved but cannot become the accepted sample',async()=>{
  const attempts=[]
  let waits=0
  const result=await isolatedReplay(async attempt=>{
    attempts.push(attempt)
    return {label:`sample-${attempt}`,resources:{hostMemory:{passed:attempt>=3}}}
  },async()=>{waits++})
  assert.deepEqual(attempts,[1,2,3])
  assert.equal(waits,3)
  assert.equal(result.label,'sample-3')
})

test('an actual replay failure stops the series instead of masquerading as contamination',async()=>{
  await assert.rejects(()=>isolatedReplay(async()=>{throw new Error('real quality failure')},async()=>{}),/real quality failure/)
})

test('foreign containers do not invalidate healthy cgroup measurements',async()=>{
  const row={swap:{foreignContainerActivityObserved:true},resources:{hostMemory:{passed:true}}}
  assert.equal(await isolatedReplay(async()=>row),row)
})

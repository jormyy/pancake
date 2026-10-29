import assert from 'node:assert/strict'
import test from 'node:test'
import { runWithCleanup } from './cleanup.mjs'

test('cleanup runs after a successful workload and preserves its result',async()=>{
  const calls=[]
  assert.equal(await runWithCleanup(async()=>{calls.push('work');return 2},async()=>{calls.push('cleanup')}),2)
  assert.deepEqual(calls,['work','cleanup'])
})

test('cleanup preserves workload failures and reports its own failures',async()=>{
  const failure=new Error('invalid identity'),cleanup=new Error('lock timeout')
  await assert.rejects(()=>runWithCleanup(async()=>{throw failure},async()=>{}),error=>error===failure)
  await assert.rejects(()=>runWithCleanup(async()=>2,async()=>{throw cleanup}),error=>error===cleanup)
  await assert.rejects(()=>runWithCleanup(async()=>{throw failure},async()=>{throw cleanup}),error=>{
    assert.ok(error instanceof AggregateError)
    assert.equal(error.cause,failure)
    assert.deepEqual(error.errors,[failure,cleanup])
    return true
  })
})

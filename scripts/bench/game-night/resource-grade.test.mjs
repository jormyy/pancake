import assert from 'node:assert/strict'
import test from 'node:test'
import {hostAvailableFloorBytes,resourceGrade} from './resource-grade.mjs'

const sample=(at,value,available=2*hostAvailableFloorBytes)=>({at,vm:{nr_free_pages:available/4096},vmMemory:{availableBytes:available,freeBytes:available},cgroup:{workingset_refault_anon:value,pgmajfault:value,zswpout:value/2}})

test('database refaults stay independent of foreign VM swap traffic',()=>{
  const samples=[sample(1000,10),sample(11000,110)]
  samples[1].vm.pswpin=999999
  samples[1].foreignContainers=[{name:'foreign'}]
  const result=resourceGrade(samples)
  assert.equal(result.primary.value,10)
  assert.equal(result.perCgroupCounters.pgmajfault.perSecond,10)
  assert.equal(result.perCgroupCounters.zswpout.perSecond,5)
  assert.equal(result.swapOutCounterAvailable,false)
  assert.equal(result.hostMemory.passed,true)
})

test('a single low available-memory observation rejects the sample',()=>{
  assert.equal(resourceGrade([sample(0,0),sample(5000,50,hostAvailableFloorBytes-1),sample(10000,100)]).hostMemory.passed,false)
})

test('historical free pages prove headroom only when their lower bound clears the floor',()=>{
  const samples=[sample(0,0),sample(10000,100)]
  for(const row of samples)delete row.vmMemory
  assert.equal(resourceGrade(samples).hostMemory.passed,true)
  samples[1].vm.nr_free_pages=1
  assert.equal(resourceGrade(samples).hostMemory.passed,null)
})

test('missing or reset primary counters cannot look like an improvement',()=>{
  assert.throws(()=>resourceGrade([sample(0,100),sample(10000,1)]),/reset/)
  const last=sample(10000,100)
  delete last.cgroup.workingset_refault_anon
  assert.throws(()=>resourceGrade([sample(0,0),last]),/Missing/)
})

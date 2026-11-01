import assert from 'node:assert/strict'
import {test} from 'node:test'
import {projectBudget} from './budget.mjs'

test('monthly budget uses all Edge requests and identifies the fixed database-size risk',()=>{
  const report={seconds:240,publicFeed:{requests:100,origins:Array.from({length:8},()=>({bytes:1000,gzipBytes:300,milliseconds:10,cpuMicroseconds:1000}))},
    phones:{messages:Array.from({length:20},()=>({})),viewBytes:10000,messageBytes:1000},
    workerDataTransfer:{requests:[{responseBytes:500}]},shape:{databaseBytes:265000000},
    memory:{cgroupAnonPeakBytes:100000000,cgroupShmemPeakBytes:80000000},diskIo:{readsPerSecond:10,writesPerSecond:20},edgeRequestCount:10}
  const budget=projectBudget(report)
  assert.equal(budget.vercel.requests.value,270000)
  assert.equal(budget.supabase.edgeInvocations.value,27000)
  assert.equal(budget.vercel.transfer.value,81000000)
  assert.equal(budget.supabase.database.fraction,0.53)
  assert.equal(budget.supabase.database.riskOverHalf,true)
  assert.equal(budget.supabase.diskIo.value,30)
  assert.equal(budget.vercelWithinHalfLimits,true)
  const observed={...report,observations:[{current:160000000},{current:170000000}]}
  assert.equal(projectBudget(observed).supabase.memory.value,170000000)
  assert.match(projectBudget(observed).supabase.memory.unit,/memory.current/)
  report.publicFeed.requests=1000
  report.phones.viewBytes=3000000
  report.diskIo.readsPerSecond=300
  const over=projectBudget(report)
  assert.equal(over.vercelWithinHalfLimits,false)
  assert.equal(over.supabaseWithinLimits,false)
  for(const name of ['Vercel requests','Supabase transfer','Supabase diskIo'])assert.ok(over.namedRisks.some(risk=>risk.includes(name)))
})

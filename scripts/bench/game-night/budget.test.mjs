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
  assert.equal(budget.supabase.edgeInvocations.value,27300)
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

test('transfer uses measured phone wire bytes while retaining the raw internal leg',()=>{
  const report={seconds:240,publicFeed:{requests:100,origins:[]},phones:{messages:[],viewReads:[{kind:'home',bytes:10000,wireBytes:1000}],
    viewBytes:10000,viewWireBytes:1000,messageBytes:0,compressionVerified:true},workerDataTransfer:{requests:[{responseBytes:10000}]},
    shape:{databaseBytes:265000000},memory:{cgroupAnonPeakBytes:100000000,cgroupShmemPeakBytes:0},diskIo:{readsPerSecond:1,writesPerSecond:1},edgeRequestCount:1}
  const result=projectBudget(report)
  assert.equal(result.supabase.transfer.value,11000*2700+11000*300)
  assert.equal(result.transferAccounting.monthlyDecodedUpperBound,20000*2700+20000*300)
  assert.equal(result.transferAccounting.gzipVerified,true)
  report.phones.architecture=true
  const recurring=projectBudget(report)
  assert.equal(recurring.recoveryReserve.calls,10800)
  assert.equal(recurring.supabase.edgeInvocations.value,result.supabase.edgeInvocations.value+10800)
  assert.equal(recurring.supabase.transfer.value,result.supabase.transfer.value+10800*16384)
})

test('Realtime bills each send once and preserves the old delivery upper bound',()=>{
  const report={seconds:240,publicFeed:{requests:100,origins:[]},phones:{messages:Array.from({length:20},()=>({})),viewBytes:0,messageBytes:0},
    functionCounters:{before:[{schemaname:'realtime',funcname:'send',calls:10}],after:[{schemaname:'realtime',funcname:'send',calls:12}]},
    realtime:{messages:2},shape:{databaseBytes:265000000},memory:{cgroupAnonPeakBytes:100000000,cgroupShmemPeakBytes:0},
    diskIo:{readsPerSecond:1,writesPerSecond:1},edgeRequestCount:1}
  const result=projectBudget(report)
  assert.equal(result.supabase.realtimeMessages.value,22*2700)
  assert.equal(result.observedBroadcasts.previousDoubleDeliveryUpperBound,40*2700)
})

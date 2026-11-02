import test from 'node:test'
import assert from 'node:assert/strict'
import { compareRecordedReference } from './series.mjs'

const report=(value=5)=>({passed:true,source:'candidate',fixtureSha256:'fixture',harnessSha256:'harness',memoryMiB:192,label:'candidate',seconds:240,
  resources:{version:'game-night-cgroup-v1',hostMemory:{passed:true}},runtimeConfiguration:{pool:2},
  swap:{inPagesPerSecond:1,outPagesPerSecond:1,cgroupAnonRefaultsPerSecond:value,cgroupSwapPeakBytes:1000},
  memory:{majorFaults:1,cgroupAnonPeakBytes:1000,cgroupShmemPeakBytes:1000},walBytesPerMinute:1,newSessionsPerMinute:1,cronRunsPerMinute:1,
  scoreFreshness:{p95Ms:30000},workCounts:{passed:true},statementExecSecondsPerMinuteByFunction:[],workerRunsPerHourByKind:{},
  quality:{passed:true,gates:{injuries:{passed:true},forecasts:{passed:true}}},
  actionResults:{records:['rosterMove','lineupSave','tradeOffer','tradeAccept','waiverResult'].map(name=>({name,passed:true,latencyMs:10}))},
  projectedBudget:{supabaseWithinAcceptedRiskLimits:true,supabaseQuarterTargets:true,vercelWithinHalfLimits:true,vercelInvocationTarget:true}})
const reference={version:'game-night-summary-v2',primaryMetric:'cgroupAnonRefaultsPerSecond',n:3,quality:{passed:true},fixtureSha256:'fixture',memoryMiB:192,source:'recorded',metrics:{cgroupAnonRefaultsPerSecond:{median:1931,spread:350}}}
const limits=Object.fromEntries(['rosterMove','lineupSave','tradeOffer','tradeAccept','waiverResult'].map(name=>[name,20]))
test('candidate-only acceptance uses a recorded reference and declares the missing pairing',()=>{
  const result=compareRecordedReference(reference,[report(),report(),report()],{limits,targetCeiling:35.09})
  assert.equal(result.passed,true)
  assert.equal(result.paired,false)
  assert.equal(result.targetPagesPerSecond,35.09)
  assert.equal(result.candidate.n,3)
  assert.equal(result.baseline.source,'recorded')
})
test('candidate-only acceptance rejects slow actions, budgets, and the fixed ceiling',()=>{
  for(const mutate of [row=>row.actionResults.records[0].latencyMs=21,row=>row.projectedBudget.supabaseWithinAcceptedRiskLimits=false,
    row=>row.quality.gates.injuries.passed=false]) {
    const rows=[report(),report(),report()];mutate(rows[0]);assert.equal(compareRecordedReference(reference,rows,{limits}).passed,false)
  }
  assert.equal(compareRecordedReference(reference,[report(36),report(36),report(36)],{limits}).passed,false)
  assert.throws(()=>compareRecordedReference(reference,[report(),report()],{limits}))
  assert.throws(()=>compareRecordedReference(reference,[report(),report(),{...report(),source:'different'}],{limits}))
  assert.throws(()=>compareRecordedReference({...reference,quality:{passed:false}},[report(),report(),report()],{limits}))
})

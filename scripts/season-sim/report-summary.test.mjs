import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptanceAreas, acceptanceGaps, countersBelongToRun, executionNotes, summarizeRun } from './report-summary.mjs'

const run = { days: [], dates: [], complete: false, fullAcceptance: false }
test('ordinary runs make no continuation or segment claim', () => {
  assert.equal(executionNotes(run), '')
  assert.deepEqual(summarizeRun(run).defectEvidence, [])
  assert.equal(summarizeRun(run).withinTwelveHours, null)
})
test('invariant failures and execution failures remain distinct', () => {
  assert.equal(summarizeRun({ ...run, failure: { name: 'AssertionError' } }).invariantFailures, 1)
  const result = summarizeRun({ ...run, failures: [{ name: 'AssertionError' }, { name: 'AssertionError' }, { name: 'Error' }] })
  assert.equal(result.invariantFailures, 2)
  assert.equal(result.executionFailures, 1)
  assert.equal(summarizeRun({ ...run, failure: { message: 'legacy failure' } }).invariantFailures, null)
})
test('a partial or interrupted run cannot silently claim acceptance', () => {
  assert.throws(() => summarizeRun({ ...run, fullAcceptance: true }))
  assert.match(executionNotes({ ...run, continuation: true, interruptions: [{}], segments: [{}, {}], elapsedIncludingPauseSeconds: 9 }), /does not count as a fresh replay/)
})

test('origin counters outside the replay window cannot become measured run totals', () => {
  const replay = { startedAt: '2026-10-20T10:00:00Z', finishedAt: '2026-10-20T11:00:00Z' }
  assert.equal(countersBelongToRun({ startedAt: '2026-10-20T10:01:00Z', lastEventRealAt: '2026-10-20T10:59:00Z' }, replay), true)
  assert.equal(countersBelongToRun({ startedAt: '2026-10-20T09:00:00Z', lastEventRealAt: '2026-10-20T10:59:00Z' }, replay), false)
  assert.equal(countersBelongToRun({ startedAt: '2026-10-20T10:01:00Z', lastEventRealAt: '2026-10-20T11:01:00Z' }, replay), false)
  assert.equal(countersBelongToRun({}, replay), false)
})

test('per-area acceptance requires measured outcomes and excludes dropped segment prerequisites', () => {
  assert.ok(Object.values(acceptanceAreas(run)).every(value => value === 'not measured'))
  assert.ok(acceptanceGaps(run).some(value => value.includes('historical replay')))
  assert.ok(!acceptanceGaps(run).some(value => /segment|Tier 2/.test(value)))
  assert.equal(acceptanceAreas({ ...run, champion: { passed: true } }).champion, 'pass')
  assert.equal(acceptanceAreas({ ...run, champion: { passed: false } }).champion, 'not measured')
})

test('a forged acceptance flag cannot bypass missing area evidence', () => {
  assert.throws(() => summarizeRun({ ...run, complete: true, fullAcceptance: true, acceptanceGaps: [], triggerFidelity: { verified: true } }), /Full acceptance/)
})

test('a reproduced unscored rookie failure cannot be labelled not measured',()=>{
  const result=acceptanceAreas({...run,realTwoSeasons:true,failure:{area:'rookie-identity',message:'Missing real rookie game'}})
  assert.equal(result['rookie identity'],'fail')
  assert.equal(result['NBA deadline trades'],'not measured')
})

test('two-season live acceptance requires a subscription result in each season',()=>{
  const measured={...run,realTwoSeasons:true,liveSamples:1,realtime:{passed:true}}
  assert.equal(acceptanceAreas(measured)['live streams'],'not measured')
  assert.equal(acceptanceAreas({...measured,realtimeSecond:{passed:true}})['live streams'],'pass')
})


test('recorded feature failures do not hide a later fatal replay failure',()=>{
  const result=summarizeRun({...run,failures:[{name:'AssertionError',message:'F1'}],failure:{name:'AssertionError',message:'fatal'}})
  assert.equal(result.invariantFailures,2)
})


test('structured extractor failures are counted even in older checkpoints',()=>{
  const result=summarizeRun({...run,featureCheckpoints:[{year:2025,label:'week-1',f1:{status:'FAILED',error:'unbalanced'}}],playersEvidence:[{year:2025,label:'after-first-final',status:'FAILED',error:'missing average'}]})
  assert.equal(result.invariantFailures,2)
})

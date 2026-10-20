import assert from 'node:assert/strict'
import test from 'node:test'
import { countersBelongToRun, executionNotes, summarizeRun } from './report-summary.mjs'

const run = { days: [], dates: [], complete: false, fullAcceptance: false }
test('ordinary runs make no continuation or segment claim', () => {
  assert.equal(executionNotes(run), '')
  assert.deepEqual(summarizeRun(run).defectEvidence, [])
  assert.equal(summarizeRun(run).withinFiveHours, null)
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

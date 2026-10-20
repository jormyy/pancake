import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mergeRerun } from './layout-stability-merge.mjs'

const row = { surface: 'home', target: 'chromium', scenario: 'cold', latencyProfile: 'slow', status: 'FAIL', evidence: 'home/cold.json' }
const report = { release: { commitSha: 'base', bundleDigest: 'bundle' }, harness: { digest: 'original' }, cells: [row] }
const rerun = { ...report, harness: { digest: 'corrected' }, cells: [{ ...row, status: 'PASS' }], command: 'rerun' }

test('paired reruns retain their raw evidence paths and harness identity', () => {
  const merged = mergeRerun(report, rerun, 'reruns/rule-2')
  assert.equal(merged.cells[0].status, 'PASS')
  assert.equal(merged.cells[0].evidence, 'reruns/rule-2/home/cold.json')
  assert.equal(merged.cells[0].harnessDigest, 'corrected')
  assert.equal(report.cells[0].status, 'FAIL')
  assert.deepEqual(merged.reruns[0].cells, ['home|chromium|cold|slow'])
})

test('reruns cannot replace another release or silently add unrelated cells', () => {
  assert.throws(() => mergeRerun(report, { ...rerun, release: { ...report.release, commitSha: 'after' } }, 'rerun'), /same release/)
  assert.throws(() => mergeRerun(report, { ...rerun, cells: [{ ...row, surface: 'other' }] }, 'rerun'), /Unknown/)
  assert.throws(() => mergeRerun(report, { ...rerun, cells: [row, row] }, 'rerun'), /duplicate/)
})

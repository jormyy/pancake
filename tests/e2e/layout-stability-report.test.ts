import assert from 'node:assert/strict'
import { test } from 'vitest'
import { sweepFailures } from './layout-stability-report.mjs'

const stable = { metrics: { maxHorizontalPx: 0, maxVerticalPx: 0, cls: 0, blankFrames: 0, reappearances: 0, loadingDurationMs: 0, spinnerDurationMs: 0, firstContentMs: 10, stableLayoutMs: 500 }, observation: { apiQuiet: false } }

test('unfinished background requests do not fail a visibly stable surface', () => {
  assert.deepEqual(sweepFailures(stable), [])
})

test('unfinished requests never excuse visible loading, movement, or blank frames', () => {
  const failures = sweepFailures({ ...stable, metrics: { ...stable.metrics, maxVerticalPx: 3, loadingDurationMs: 50, blankFrames: 1 } })
  assert.deepEqual(failures, ['vertical displacement 3px', '1 blank frames', 'loading text 50ms'])
})

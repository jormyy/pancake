import assert from 'node:assert/strict'
import { test } from 'vitest'
import { layoutShiftSessionScore } from './web-targets-geometry.mjs'

test('CLS starts its five-second window at the first shift, not navigation', () => {
  const entries = [100, 900, 1700, 2500, 3300, 4100, 4900, 5100].map((t) => ({ t, value: 0.1, hadRecentInput: false }))
  assert.ok(Math.abs(layoutShiftSessionScore(entries) - 0.8) < 1e-10)
})

test('CLS separates a one-second gap and excludes recent input', () => {
  assert.equal(layoutShiftSessionScore([
    { t: 100, value: 0.1, hadRecentInput: false },
    { t: 900, value: 0.9, hadRecentInput: true },
    { t: 1100, value: 0.2, hadRecentInput: false },
    { t: 1150, value: 0.2, hadRecentInput: false },
  ]), 0.4)
})

test('CLS resets beyond five seconds even when consecutive gaps stay short', () => {
  const entries = [100, 900, 1700, 2500, 3300, 4100, 4900, 5101].map((t) => ({ t, value: 0.1, hadRecentInput: false }))
  assert.ok(Math.abs(layoutShiftSessionScore(entries) - 0.7) < 1e-10)
})

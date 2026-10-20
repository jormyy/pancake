import assert from 'node:assert/strict'
import test from 'node:test'
import { launcherCheck } from './launcher-check.mjs'

test('bounded launcher checks require both snapshots through October 27', () => {
  assert.equal(launcherCheck({}), null)
  assert.equal(launcherCheck({ 'check-first-date': true }).days, 1)
  const check = launcherCheck({ 'check-through': '2025-10-27' })
  assert.equal(check.days, 7)
  assert.equal(check.dates.at(-1), '2025-10-27')
  assert.deepEqual(check.snapshots, ['waiver-week', 'live-week'])
})

test('bounded launcher checks reject conflicting modes and dates beyond their limit', () => {
  assert.throws(() => launcherCheck({ 'check-first-date': true, 'check-through': '2025-10-27' }), /Choose one/)
  for (const through of ['2025-10-20', '2025-10-28', '2026-02-30', 'invalid']) assert.throws(() => launcherCheck({ 'check-through': through }))
})

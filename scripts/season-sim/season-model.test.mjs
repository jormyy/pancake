import assert from 'node:assert/strict'
import test from 'node:test'
import { seasonProfile, regularGame, monday } from './season-model.mjs'

test('season profiles derive IDs and years for both real seasons', () => {
  assert.equal(seasonProfile(2025).prefix, '00224')
  assert.equal(seasonProfile(2026).label, '2025-26')
  assert.equal(monday('2024-10-22'), '2024-10-21')
  assert.throws(() => seasonProfile(2000))
  for (const prefix of ['001', '003', '004', '005', '006']) assert.equal(regularGame(`${prefix}2400001`), false)
  assert.ok(regularGame('0022400001'))
  assert.ok(regularGame('0022500001'))
})

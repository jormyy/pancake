import assert from 'node:assert/strict'
import test from 'node:test'
import { officialLeagueSettings } from './actions.mjs'

test('late official configuration keeps profile skips and adds every completed past week', () => {
  const settings = { skipped_weeks: [1, 20], playoff_start_week: 18, playoff_round_lengths: [2, 2], waiver_mode: 'faab' }
  const past = Array.from({ length: 16 }, (_, index) => index + 1)
  const merged = officialLeagueSettings(settings, past)
  assert.deepEqual(merged.skipped_weeks, [...past, 20])
  assert.deepEqual({ ...merged, skipped_weeks: settings.skipped_weeks }, settings)
  assert.deepEqual(settings.skipped_weeks, [1, 20])
  assert.deepEqual(past, Array.from({ length: 16 }, (_, index) => index + 1))
})

test('full official configuration retains the exact profile settings', () => {
  const settings = { skipped_weeks: [1], playoff_start_week: 18 }
  assert.equal(officialLeagueSettings(settings, null), settings)
  assert.deepEqual(officialLeagueSettings(settings, []), settings)
})

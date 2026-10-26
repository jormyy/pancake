import assert from 'node:assert/strict'
import test from 'node:test'
import { forecastSplit, scoreForecastReceipt } from './official-forecast.mjs'

test('forecast evaluation keeps reserved weeks outside development', () => {
  for (const week of [10, 13, 16]) assert.equal(forecastSplit(week, 'regular_season'), 'calibration-held-out')
  assert.equal(forecastSplit(17, 'regular_season'), 'final-held-out')
  assert.equal(forecastSplit(18, 'playoff_semifinal'), 'final-held-out')
  assert.equal(forecastSplit(9, 'regular_season'), 'development')
})

test('forecast scores compare with constant and prior-mean baselines without treating missing odds as predictions', () => {
  const receipt = { forecast: { teams: [{ memberId: 'a', winProbability: 0.8 }] }, baseline: [{ memberId: 'a', mean: 90 }, { memberId: 'b', mean: 100 }] }
  const final = { is_finalized: true, home_member_id: 'a', away_member_id: 'b', home_points: 100, away_points: 90 }
  const result = scoreForecastReceipt(receipt, final)
  assert.ok(Math.abs(result.brier - 0.04) < 1e-12)
  assert.equal(result.constantBrier, 0.25)
  assert.equal(result.meanWinnerBrier, 1)
  assert.equal(scoreForecastReceipt({ ...receipt, forecast: null }, final).brier, null)
  assert.throws(() => scoreForecastReceipt({ ...receipt, forecast: { teams: [{ memberId: 'a', winProbability: 8 }] } }, final))
  assert.throws(() => scoreForecastReceipt(receipt, { ...final, is_finalized: false }))
})

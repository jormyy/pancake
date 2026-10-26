import test from 'node:test'
import assert from 'node:assert/strict'
import { checkAnchoredValue } from './official-value-anchors.mjs'

test('frozen anchors reject implausible players, picks and FAAB independently of returned model ranges', () => {
  for (const [anchor, accepted, rejected] of [['highProduction', 600, 50], ['lowProductionVeteran', 100, 900], ['nextFirst', 600, 10], ['nextThird', 200, 950], ['tenPercentFaab', 10, 100], ['halfBudgetFaab', 50, 800]]) {
    assert.equal(checkAnchoredValue(accepted, anchor).passed, true)
    assert.throws(() => checkAnchoredValue(rejected, anchor), /outside frozen judgment/)
    assert.throws(() => checkAnchoredValue(NaN, anchor))
  }
})

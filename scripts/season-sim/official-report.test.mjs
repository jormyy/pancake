import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeOfficial } from './official-report.mjs'

const complete = () => ({ scenario: { profile: { firstYear: 2025 } }, complete: true, fullRangeComplete: true, auction: { players: 200 }, days: [{ seasonYear: 2025, closedWeeks: Array.from({ length: 16 }, (_, index) => ({ week: index + 2 })) }, { seasonYear: 2026, closedWeeks: [{ week: 2 }] }], champion: { passed: true }, rollover: { passed: true }, rookieDraft: { passed: true, picks: 30 }, snapshots: [{ name: 'pre-playoffs' }], waivers: { checked: true }, trades: { completed: { checked: true, quoteReceipts: ['received', 'accepted', 'executed'].map(phase => ({ phase })) }, vetoed: { checked: true }, deadline: { checked: true } }, tradeValueAudits: [10, 13, 16, 17].map(week => ({ week, receipts: [1, 2, 3] })), liveSamples: 1, corruptionControls: Array.from({ length: 4 }, () => ({ detected: true })), forecasts: [10, 13, 16, 17].map(week => ({ week, split: week === 17 ? 'final-held-out' : 'calibration-held-out', outcome: { brier: 0.2, constantBrier: 0.25, meanWinnerBrier: 0.5 } })) })

test('bounded diagnostics and missing gates cannot certify the full historical replay', () => {
  assert.equal(summarizeOfficial(complete()).fullAcceptance, true)
  for (const change of [report => { report.fullRangeComplete = false }, report => { report.auction.players = 199 }, report => { report.days[0].closedWeeks.pop() }, report => { report.forecasts = [] }, report => { report.rookieDraft.picks = 20 }, report => { report.corruptionControls.pop() }]) {
    const report = complete()
    change(report)
    assert.equal(summarizeOfficial(report).fullAcceptance, false)
  }
})

test('missing probabilities remain cold coverage and fail calibration acceptance', () => {
  const report = complete()
  for (const row of report.forecasts) row.outcome.brier = null
  const result = summarizeOfficial(report)
  assert.equal(result.fullAcceptance, false)
  assert.equal(result.forecast.find(row => row.split === 'calibration-held-out').cold, 3)
  assert.equal(result.forecast.find(row => row.split === 'calibration-held-out').brier, null)
})

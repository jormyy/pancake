import { catalogIdentity } from './official-outcomes.mjs'
import { productionJobs } from './cron.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { reliabilityBins, summarizeOfficial } from './official-report.mjs'

const complete = () => ({ triggerFidelity: { version: 2, coverage: { invoked: { 'nba-live-poll': 1 } }, phases: [{ phase: 'initial', catalogHash: catalogIdentity(productionJobs), before: 0, through: 1, nativeCount: 1, invocations: [{ id: 1, invocation_key: 'worker-1', function_name: 'sync-schedule' }], counts: { 'nba-live-poll': 1 } }], catalogVerified: true, catalog: productionJobs, counts: { 'nba-live-poll': 1 }, verified: true, reconciled: true, unexpected: [], outcomes: [{ phase: 'initial', at: '2024-10-22T10:00:00Z', outcome: { id: 1, invocation_key: 'worker-1', function_name: 'sync-schedule', status_code: 200, worker_status: 'success', sync_status: 'success', content: '{}' }, providers: [], classification: { kind: 'supported-success', gaps: [] } }] }, scenario: { profile: { firstYear: 2025 } }, complete: true, fullRangeComplete: true, auction: { players: 200 }, days: [{ seasonYear: 2025, closedWeeks: Array.from({ length: 16 }, (_, index) => ({ week: index + 2 })) }, { seasonYear: 2026, closedWeeks: [{ week: 2 }] }], champion: { passed: true }, rollover: { passed: true }, rookieDraft: { passed: true, picks: 30 }, snapshots: [{ name: 'pre-playoffs' }], waivers: { checked: true }, trades: { completed: { checked: true, playerSettlement: { passed: true }, postTradeScoring: { passed: true }, quoteReceipts: ['received', 'accepted', 'executed'].map(phase => ({ phase })) }, playerCycle: { checked: true, postTradeScoring: { passed: true } }, vetoed: { checked: true }, deadline: { checked: true } }, tradeValueAudits: [10, 13, 16, 17].map(week => ({ week, receipts: [1, 2, 3], anchors: { passed: true } })), liveSamples: 1, corruptionControls: Array.from({ length: 4 }, () => ({ detected: true })), forecasts: [10, 13, 16, 17].map(week => ({ week, split: week === 17 ? 'final-held-out' : 'calibration-held-out', outcome: { brier: 0.2, constantBrier: 0.25, meanWinnerBrier: 0.5 } })) })

test('bounded diagnostics and missing gates cannot certify the full historical replay', () => {
  assert.equal(summarizeOfficial(complete()).fullAcceptance, true)
  for (const change of [report => { report.triggerFidelity = undefined }, report => { report.triggerFidelity.verified = false }, report => { report.triggerFidelity.outcomes[0].outcome.worker_status = 'failed' }, report => { report.fullRangeComplete = false }, report => { report.auction.players = 199 }, report => { report.days[0].closedWeeks.pop() }, report => { report.forecasts = [] }, report => { report.rookieDraft.picks = 20 }, report => { report.corruptionControls.pop() }]) {
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

test('reliability bins retain direction, boundary probabilities, and separate ties', () => {
  const rows = [[0, 0], [0.1, 1], [0.2, 1], [0.9, 0], [1, 1], [0.85, 0.5], [null, 1]].map(([probability, outcome]) => ({ outcome: { probability, outcome } }))
  const bins = reliabilityBins(rows)
  assert.deepEqual(bins[0], { lower: 0, upper: 0.2, count: 2, meanForecast: 0.05, observedWinFrequency: 0.5, ties: 0 })
  assert.equal(bins[1].observedWinFrequency, 1)
  assert.equal(bins[4].count, 2)
  assert.equal(bins[4].meanForecast, 0.95)
  assert.equal(bins[4].observedWinFrequency, 0.5)
  assert.equal(bins[4].ties, 1)
  assert.equal(bins.reduce((sum, bin) => sum + bin.count, 0), 5)
  assert.equal(bins[2].observedWinFrequency, null)
})

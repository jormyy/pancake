import { catalogIdentity } from './official-outcomes.mjs'
import { shiftDay } from './season-model.mjs'
import { productionJobs } from './cron.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { reliabilityBins, summarizeOfficial } from './official-report.mjs'

const complete = () => ({ triggerFidelity: { version: 2, coverage: { invoked: { 'work-dispatcher': 1 } }, phases: [{ phase: 'initial', catalogHash: catalogIdentity(productionJobs), before: 0, through: 1, nativeCount: 1, invocations: [{ id: 1, invocation_key: 'worker-1', function_name: 'sync-schedule' }], counts: { 'work-dispatcher': 1 } }], catalogVerified: true, catalog: productionJobs, counts: { 'work-dispatcher': 1 }, verified: true, reconciled: true, unexpected: [], outcomes: [{ phase: 'initial', at: '2024-10-22T10:00:00Z', outcome: { id: 1, invocation_key: 'worker-1', function_name: 'sync-schedule', status_code: 200, worker_status: 'success', sync_status: 'success', content: '{}' }, providers: [], classification: { kind: 'supported-success', gaps: [] } }] }, scenario: { profile: { firstYear: 2025 } }, complete: true, fullRangeComplete: true, auction: { players: 200 }, days: [{ seasonYear: 2025, closedWeeks: Array.from({ length: 16 }, (_, index) => ({ week: index + 2 })) }, { seasonYear: 2026, closedWeeks: [{ week: 2 }] }], champion: { passed: true }, rollover: { passed: true }, rookieDraft: { passed: true, picks: 30 }, snapshots: [{ name: 'pre-playoffs' }], waivers: { checked: true }, trades: { completed: { checked: true, playerSettlement: { passed: true }, postTradeScoring: { passed: true }, quoteReceipts: ['received', 'accepted', 'executed'].map(phase => ({ phase })) }, playerCycle: { checked: true, postTradeScoring: { passed: true } }, vetoed: { checked: true }, deadline: { checked: true } }, tradeValueAudits: [10, 13, 16, 17].map(week => ({ week, receipts: [1, 2, 3], anchors: { passed: true } })), liveSamples: 1, corruptionControls: Array.from({ length: 4 }, () => ({ detected: true })), forecasts: [10, 13, 16, 17].map(week => ({ week, split: week === 17 ? 'final-held-out' : 'calibration-held-out', outcome: { brier: 0.2, constantBrier: 0.25, meanWinnerBrier: 0.5 } })) })

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

const lateComplete = (start = '2025-02-10') => {
  const report = complete()
  const weeks = Array.from({ length: 24 }, (_, index) => {
    const week = index + 1
    const begin = shiftDay('2024-10-21', (index + (week > 17 ? 1 : 0)) * 7)
    return { week_number: week, week_start: week === 1 ? '2024-10-22' : begin, week_end: shiftDay(begin, week === 17 ? 13 : 6) }
  })
  report.scenario.profile.settings = { skipped_weeks: [1], playoff_start_week: 18, playoff_round_lengths: [2, 2] }
  report.bounds = { checkpoint: '2025-02-10' }
  report.lateStart = { start, weeks }
  report.days = [
    ...weeks.filter(row => row.week_number >= 17 && row.week_number <= 21).map(row => ({ date: row.week_start < start ? start : row.week_start, week: row.week_number, seasonYear: 2025, scores: { passed: true, matchups: 5 }, closedWeeks: row.week_number === 17 ? [{ week: 17 }] : [] })),
    { date: '2025-11-03', week: 2, seasonYear: 2026, scores: { passed: true, matchups: 5 }, closedWeeks: [{ week: 2 }] },
  ]
  report.snapshots = []
  delete report.trades.completed
  delete report.trades.playerCycle
  delete report.trades.vetoed
  report.tradeValueAudits = report.tradeValueAudits.filter(row => row.week === 17)
  report.forecasts = [17, 18, 20].map(week => ({ week, split: 'final-held-out', outcome: { brier: 0.2, constantBrier: 0.25, meanWinnerBrier: 0.5 } }))
  report.realtime = { passed: true }
  return report
}

test('late acceptance measures the remaining season without granting full acceptance', () => {
  const summary = summarizeOfficial(lateComplete())
  assert.equal(summary.fullAcceptance, false)
  assert.equal(summary.lateStart.start, '2025-02-10')
  assert.equal(summary.lateStart.passed, true)
  assert.deepEqual(summary.lateStart.gaps, [])
  assert.deepEqual(summary.gaps, [])
  for (const name of ['regularSeasonWeek2', 'regularSeasonWeek16', 'forecastCalibration', 'forecastCalibrationWeek10', 'forecastCalibrationWeek13', 'forecastCalibrationWeek16', 'taxiWeekTwoAcquisitions', 'mixedPlayerTrade', 'threeTeamPlayerTrade', 'memberVeto', 'tradeQuotes', 'checkpoint']) {
    assert.equal(summary.gates[name], 'not measured: late start')
    assert.ok(summary.lateStart.notMeasured.includes(name))
  }
  for (const name of ['regularSeasonWeek17', 'continuousFaab', 'deadline', 'forecastFinalHoldout', 'forecastFinalWeek17', 'forecastFinalWeek18', 'forecastFinalWeek20', 'championship', 'rollover', 'rookieDraft', 'nextEligibleWeek', 'realtimeDelivery', 'workerFidelity', 'noFailure']) assert.equal(summary.gates[name], true)
})

test('each missing measurable late area fails acceptance', () => {
  const controls = [
    { area: 'regularSeason', change: report => { report.days[0].closedWeeks = [] } },
    { area: 'measuredScoring', change: report => { report.days[2].scores.passed = false } },
    { area: 'initialAuction', change: report => { report.auction.players = 199 } },
    { area: 'continuousFaab', change: report => { report.waivers.checked = false } },
    { area: 'deadline', change: report => { report.trades.deadline.checked = false } },
    { area: 'forecastFinalHoldout', change: report => { report.forecasts.pop() } },
    { area: 'forecastFinalHoldout', change: report => { report.forecasts[0].outcome.brier = null } },
    { area: 'championship', change: report => { report.champion.passed = false } },
    { area: 'rollover', change: report => { report.rollover.passed = false } },
    { area: 'rookieDraft', change: report => { report.rookieDraft.picks = 29 } },
    { area: 'nextEligibleWeek', change: report => { report.days.at(-1).closedWeeks = [] } },
    { area: 'nextOpeningScoring', change: report => { report.days.at(-1).scores.passed = false } },
    { area: 'realtimeDelivery', change: report => { report.realtime.passed = false } },
    { area: 'workerFidelity', change: report => { report.triggerFidelity.verified = false } },
    { area: 'noFailure', change: report => { report.invariantFailures = 1 } },
    { area: 'noFailure', change: report => { report.failures = [{ message: 'failure' }] } },
    { area: 'noFailure', change: report => { report.cleanupError = 'failed' } },
    { area: 'noFailure', change: report => { report.error = 'failed' } },
    { area: 'sourceIntegrity', change: report => { report.sourceMismatch = true } },
    { area: 'requestedRangeComplete', change: report => { report.fullRangeComplete = false } },
    { area: 'tradeValueAudits', change: report => { report.tradeValueAudits = [] } },
    { area: 'tradeValueAnchors', change: report => { report.tradeValueAudits[0].anchors.passed = false } },
    { area: 'corruptionControls', change: report => { report.corruptionControls.pop() } },
  ]
  for (const { area, change } of controls) {
    const report = lateComplete()
    change(report)
    const summary = summarizeOfficial(report)
    assert.equal(summary.lateStart.passed, false, area)
    assert.ok(summary.lateStart.gaps.includes(area), area)
  }
})

test('midweek late acceptance excludes preweek receipts but still requires partial-week scoring', () => {
  const report = lateComplete('2025-02-12')
  report.forecasts = report.forecasts.filter(row => row.week !== 17)
  report.tradeValueAudits = []
  delete report.trades.deadline
  const summary = summarizeOfficial(report)
  assert.equal(summary.lateStart.passed, true)
  for (const name of ['regularSeasonWeek17', 'deadline', 'forecastFinalWeek17', 'tradeValueAuditsWeek17']) assert.equal(summary.gates[name], 'not measured: late start')
  report.days[0].scores.passed = false
  assert.equal(summarizeOfficial(report).lateStart.passed, false)
})

import { fidelityPass } from './official-outcomes.mjs'

export function reliabilityBins(rows) {
  return Array.from({ length: 5 }, (_, index) => {
    const selected = rows.map(row => row.outcome).filter(row => Number.isFinite(row.probability) && row.probability >= 0 && row.probability <= 1 && Math.min(4, Math.floor(row.probability * 5)) === index)
    const decisive = selected.filter(row => row.outcome === 0 || row.outcome === 1)
    return { lower: index / 5, upper: (index + 1) / 5, count: decisive.length, meanForecast: decisive.length ? decisive.reduce((sum, row) => sum + row.probability, 0) / decisive.length : null, observedWinFrequency: decisive.length ? decisive.reduce((sum, row) => sum + row.outcome, 0) / decisive.length : null, ties: selected.filter(row => row.outcome === 0.5).length }
  })
}

export function summarizeOfficial(report) {
  const firstYear = report.scenario.profile.firstYear
  const regularWeeks = new Set(report.days.filter(day => day.seasonYear === firstYear).flatMap(day => (day.closedWeeks ?? []).map(row => row.week)))
  const nextWeeks = new Set(report.days.filter(day => day.seasonYear === firstYear + 1).flatMap(day => (day.closedWeeks ?? []).map(row => row.week)))
  const gates = {
    workerFidelity: fidelityPass(report.triggerFidelity),
    noFailure: !report.error && !report.cleanupError,
    sourceIntegrity: report.sourceMismatch !== true,
    requestedRangeComplete: report.complete === true && report.fullRangeComplete === true,
    initialAuction: report.auction?.players === 200,
    regularSeason: Array.from({ length: 16 }, (_, index) => index + 2).every(week => regularWeeks.has(week)),
    championship: report.champion?.passed === true,
    rollover: report.rollover?.passed === true,
    rookieDraft: report.rookieDraft?.passed === true && report.rookieDraft.picks === 30,
    nextEligibleWeek: nextWeeks.has(2),
    checkpoint: report.snapshots.some(row => row.name === 'pre-playoffs'),
    continuousFaab: report.waivers?.checked === true,
    completedTrade: report.trades?.completed?.checked === true,
    mixedPlayerTrade: report.trades?.completed?.playerSettlement?.passed === true && report.trades?.completed?.postTradeScoring?.passed === true,
    threeTeamPlayerTrade: report.trades?.playerCycle?.checked === true && report.trades?.playerCycle?.postTradeScoring?.passed === true,
    memberVeto: report.trades?.vetoed?.checked === true,
    deadline: report.trades?.deadline?.checked === true,
    tradeQuotes: ['received', 'accepted', 'executed'].every(phase => report.trades?.completed?.quoteReceipts?.some(row => row.phase === phase)),
    tradeValueAudits: [10, 13, 16, 17].every(week => report.tradeValueAudits?.some(row => row.week === week && row.receipts.length === 3)),
    tradeValueAnchors: [10, 13, 16, 17].every(week => report.tradeValueAudits?.some(row => row.week === week && row.anchors?.passed === true)),
    liveScores: report.liveSamples > 0,
    corruptionControls: report.corruptionControls?.length === 4 && report.corruptionControls.every(row => row.detected),
  }
  const forecast = ['development', 'calibration-held-out', 'final-held-out'].map(split => {
    const rows = (report.forecasts ?? []).filter(row => row.split === split && row.outcome && row.preweek !== false)
    const scored = rows.filter(row => row.outcome.brier !== null)
    const mean = key => {
      const values = scored.map(row => row.outcome[key]).filter(value => value !== null)
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
    }
    return { split, outcomes: rows.length, covered: scored.length, cold: rows.length - scored.length, brier: mean('brier'), constantBrier: mean('constantBrier'), meanWinnerBrier: mean('meanWinnerBrier'), reliability: reliabilityBins(rows) }
  })
  gates.forecastReceipts = [10, 13, 16, 17].every(week => (report.forecasts ?? []).some(row => row.week === week && row.outcome && row.preweek !== false))
  gates.forecastCalibration = ['calibration-held-out', 'final-held-out'].every(split => forecast.some(row => row.split === split && row.covered > 0))
  const late = report.lateStart ? lateStartAcceptance(report, gates, regularWeeks) : null
  const measuredGates = late?.gates ?? gates
  return { scope: 'Historical replay core; browser, load, and app updates require separate evidence', gates: measuredGates, gaps: Object.entries(measuredGates).filter(([, passed]) => passed === false).map(([name]) => name), fullAcceptance: !late && Object.values(gates).every(Boolean), ...(late ? { lateStart: late.summary, failures: report.failures ?? [] } : {}), forecast, complete: report.complete, completedDates: report.days.length, verifiedGames: report.days.reduce((sum, day) => sum + (day.finals?.games ?? 0), 0), requestedDates: report.requestedDates, freshDatabase: report.freshDatabase, liveSamples: report.liveSamples, invariantFailures: late ? Math.max(report.invariantFailures ?? 0, report.error || report.cleanupError ? 1 : 0) : report.error ? 1 : 0, metadataLimits: report.metadataLimits }
}

function lateStartAcceptance(report, fullGates, regularWeeks) {
  const { start, weeks } = report.lateStart
  const profile = report.scenario.profile
  const skipped = profile.settings.skipped_weeks
  const gates = { ...fullGates }
  const notMeasured = 'not measured: late start'
  const window = (name, begins, passed) => { gates[name] = begins < start ? notMeasured : passed }
  const weekStart = week => weeks.find(row => row.week_number === week)?.week_start ?? ''
  const eligibleRegular = weeks.filter(row => row.week_number < profile.settings.playoff_start_week && !skipped.includes(row.week_number))
  for (const row of eligibleRegular) window(`regularSeasonWeek${row.week_number}`, row.week_start, regularWeeks.has(row.week_number))
  const measuredRegular = eligibleRegular.filter(row => row.week_start >= start)
  gates.regularSeason = measuredRegular.length ? measuredRegular.every(row => regularWeeks.has(row.week_number)) : notMeasured
  const firstDays = report.days.filter(day => day.seasonYear === profile.firstYear)
  const playoffEnd = profile.settings.playoff_start_week + profile.settings.playoff_round_lengths.reduce((sum, length) => sum + length, 0) - 1
  const scoringWeeks = weeks.filter(row => row.week_end >= start && row.week_number <= playoffEnd && !skipped.includes(row.week_number))
  gates.measuredScoring = scoringWeeks.length > 0 && scoringWeeks.every(row => firstDays.some(day => day.week === row.week_number && day.scores?.passed === true && day.scores.matchups > 0))
  window('checkpoint', report.bounds.checkpoint, fullGates.checkpoint)
  if (start === report.bounds.checkpoint) gates.checkpoint = notMeasured
  for (const name of ['completedTrade', 'mixedPlayerTrade', 'tradeQuotes']) window(name, '2024-11-01', fullGates[name])
  window('threeTeamPlayerTrade', '2025-01-10', fullGates.threeTeamPlayerTrade)
  window('memberVeto', '2024-12-01', fullGates.memberVeto)
  window('deadline', '2025-02-10', fullGates.deadline)
  window('taxiWeekTwoAcquisitions', weekStart(2), report.taxiAcquisitions?.checked === true)
  const auditWeeks = [10, 13, 16, 17]
  for (const week of auditWeeks) {
    window(`tradeValueAuditsWeek${week}`, weekStart(week), report.tradeValueAudits?.some(row => row.week === week && row.receipts.length === 3) === true)
    window(`tradeValueAnchorsWeek${week}`, weekStart(week), report.tradeValueAudits?.some(row => row.week === week && row.anchors?.passed === true) === true)
  }
  const audits = auditWeeks.filter(week => weekStart(week) >= start)
  gates.tradeValueAudits = audits.length ? audits.every(week => gates[`tradeValueAuditsWeek${week}`] === true) : notMeasured
  gates.tradeValueAnchors = audits.length ? audits.every(week => gates[`tradeValueAnchorsWeek${week}`] === true) : notMeasured
  const forecasts = (report.forecasts ?? []).filter(row => row.outcome && row.preweek !== false)
  const covered = week => forecasts.some(row => row.week === week && row.split === (week >= 17 ? 'final-held-out' : 'calibration-held-out') && Number.isFinite(row.outcome.brier))
  for (const week of [10, 13, 16]) window(`forecastCalibrationWeek${week}`, weekStart(week), covered(week))
  const calibration = [10, 13, 16].filter(week => weekStart(week) >= start)
  gates.forecastCalibration = calibration.length ? calibration.every(covered) : notMeasured
  const receiptWeeks = auditWeeks.filter(week => weekStart(week) >= start)
  gates.forecastReceipts = receiptWeeks.length ? receiptWeeks.every(week => forecasts.some(row => row.week === week)) : notMeasured
  let roundStart = profile.settings.playoff_start_week
  const finalWeeks = [17, ...profile.settings.playoff_round_lengths.map(length => {
    const first = roundStart
    roundStart += length
    return first
  })]
  for (const week of finalWeeks) window(`forecastFinalWeek${week}`, weekStart(week), covered(week))
  const final = finalWeeks.filter(week => weekStart(week) >= start)
  gates.forecastFinalHoldout = final.length ? final.every(covered) : notMeasured
  gates.nextOpeningScoring = report.days.some(day => day.seasonYear === profile.firstYear + 1 && day.week === 2 && day.scores?.passed === true && day.scores.matchups > 0)
  gates.realtimeDelivery = report.realtime?.passed === true
  gates.noFailure = fullGates.noFailure && !report.failure && !(report.failures?.length > 0) && (report.invariantFailures ?? 0) === 0
  const entries = Object.entries(gates)
  const gaps = entries.filter(([, passed]) => passed === false).map(([name]) => name)
  return { gates, summary: { start, passed: gaps.length === 0, notMeasured: entries.filter(([, passed]) => passed === notMeasured).map(([name]) => name), gaps } }
}

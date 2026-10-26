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
  return { scope: 'Historical replay core; browser, load, and app updates require separate evidence', gates, gaps: Object.entries(gates).filter(([, passed]) => !passed).map(([name]) => name), fullAcceptance: Object.values(gates).every(Boolean), forecast, complete: report.complete, completedDates: report.days.length, verifiedGames: report.days.reduce((sum, day) => sum + (day.finals?.games ?? 0), 0), requestedDates: report.requestedDates, freshDatabase: report.freshDatabase, liveSamples: report.liveSamples, invariantFailures: report.error ? 1 : 0, metadataLimits: report.metadataLimits }
}

export function twoDayGates(report) {
  return {
    liveTicks: report.liveSamples > 0 && report.events?.live > 0,
    overnightFinalization: report.days?.length === 2 && report.days.every(day => day.finals?.passed === true),
    preTipoff: report.events?.['pre-tipoff'] > 0 && report.days?.some(day => day.lineups?.postLockRejections > 0) === true,
    waivers: report.waivers?.some(row => row.checked && row.result) === true,
    tradeProposed: Boolean(report.twoDayTrade?.proposed),
    tradeCountered: Boolean(report.twoDayTrade?.countered),
    tradeAccepted: report.twoDayTrade?.completed === true,
    forecasts: report.days?.length === 2 && report.days.every(day => day.forecasts?.length > 0),
    realtime: report.realtime?.passed === true,
  }
}

export function failedTwoDayReceipt(report, message, captureProfile = 'full') {
  return { days: 2, fidelity: 'production-cadence', captureProfile, attempted: true, passed: false,
    gates: twoDayGates(report), source: report.source ?? null, productionRetries: report.productionRetries ?? [],
    error: message, report: 'replay-checkpoint.json' }
}

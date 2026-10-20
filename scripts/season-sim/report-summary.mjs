import assert from 'node:assert/strict'

export function summarizeRun(replay) {
  const failures = replay.failures ?? (replay.failure ? [replay.failure] : [])
  const invariantFailures = failures.filter(failure => failure.name === 'AssertionError').length
  const unclassifiedFailures = failures.filter(failure => !failure.name).length
  const summary = {
    scope: 'Card-area outcomes; ancillary ranking and projection quality is excluded',
    startedAt: replay.startedAt, finishedAt: replay.finishedAt ?? null,
    wallSeconds: replay.wallSeconds ?? null, complete: replay.complete === true,
    fullAcceptance: replay.fullAcceptance === true, completedDates: replay.days.length,
    requestedDates: replay.dates.length, failures, invariantFailures: unclassifiedFailures ? null : invariantFailures,
    executionFailures: failures.filter(failure => failure.name && failure.name !== 'AssertionError').length + (replay.triggerFidelity?.unsupportedInputs?.length ?? 0),
    segments: replay.segments ?? [], interruptions: replay.interruptions ?? [],
    defectEvidence: replay.defectEvidence ?? [], datasetEvidence: replay.datasetEvidence ?? [],
    triggerFidelity: replay.triggerFidelity ?? { verified: false },
    acceptanceGaps: replay.acceptanceGaps ?? [], areas: acceptanceAreas(replay),
    withinTwelveHours: !replay.complete || replay.wallSeconds == null ? null : replay.wallSeconds <= 43200,
  }
  assert.ok(!summary.fullAcceptance || (summary.complete && !failures.length && !summary.acceptanceGaps.length && summary.triggerFidelity.verified && !acceptanceGaps(replay).length), 'Full acceptance requires complete measured coverage and production triggers')
  return summary
}

export function executionNotes(replay) {
  const notes = []
  if (replay.segments?.length > 1) notes.push('Active time sums the recorded execution segments.')
  if (replay.interruptions?.length) notes.push(`Recorded interruptions: ${replay.interruptions.length}.`)
  if (replay.elapsedIncludingPauseSeconds != null && replay.interruptions?.length) notes.push(`Elapsed time including pauses: ${replay.elapsedIncludingPauseSeconds} seconds.`)
  if (replay.continuation === true) notes.push('This run starts from retained state. It does not count as a fresh replay.')
  return notes.join('\n')
}

export function countersBelongToRun(upstream, replay) {
  return !!(upstream.startedAt && upstream.lastEventRealAt && upstream.startedAt >= replay.startedAt && upstream.lastEventRealAt <= replay.finishedAt)
}

export function acceptanceAreas(run) {
  const waivers = run.waivers ?? []
  const checked = name => waivers.some(row => row.name === name && row.checked && row.result?.passed)
  const yes = value => value ? 'pass' : 'not measured'
  return {
    'live streams': yes(run.liveSamples > 0 && run.realtime?.passed),
    'weekly scoring': yes(run.days.some(day => day.weekly?.length > 0) && run.nextSeason?.checked?.includes(3)),
    playoffs: yes(run.seasonEnd?.playoffGames > 0 && run.seasonEnd?.passed),
    champion: yes(run.champion?.passed),
    'trade deadline': yes(run.actions?.tradeDeadline?.postDeadlinePassed && run.tradingReopened?.passed),
    'rookie draft': yes(run.rookieAutoPick?.passed && run.seasonEnd?.rookiePicks > 0),
    'picks across seasons': yes(run.pickAllocation?.passed && run.offseasonTrade?.passed && run.nextSeason?.historyPreserved),
    FAAB: yes(checked('season-one-faab')),
    'rolling order': yes(checked('skipped-week-rolling') && checked('eligible-week-rolling')),
    'waiver limits': yes(checked('season-one-faab') && checked('eligible-week-rolling') && run.waiverRollover?.passed),
    'skipped week 1 / first eligible week': yes(run.nextSeason?.passed && run.nextSeason?.checked?.join(',') === '2,3'),
    rollover: yes(run.seasonEnd?.historyPreserved && run.waiverRollover?.passed && run.nextSeason?.historyPreserved),
  }
}

export function acceptanceGaps(run) {
  const gaps = Object.entries(acceptanceAreas(run)).filter(([, value]) => value !== 'pass').map(([name]) => `Unverified: ${name}`)
  if (!run.complete || run.days.length !== 174 || run.dates[0] !== '2025-10-21') gaps.push('A complete historical replay remains required')
  if (!run.freshDatabase || run.continuation || run.interruptions?.length) gaps.push('A fresh uninterrupted database replay remains required')
  if (!run.source?.committedHarness) gaps.push('The running harness differs from the committed application archive')
  if (!run.triggerFidelity?.verified) gaps.push('Production trigger coverage remains unverified')
  if (run.failure || run.failures?.length) gaps.push('The run has failures')
  return gaps
}

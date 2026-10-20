import assert from 'node:assert/strict'

export function summarizeRun(replay) {
  const failures = replay.failures ?? (replay.failure ? [replay.failure] : [])
  const invariantFailures = failures.filter(failure => failure.name === 'AssertionError').length
  const unclassifiedFailures = failures.filter(failure => !failure.name).length
  const summary = {
    startedAt: replay.startedAt, finishedAt: replay.finishedAt ?? null,
    wallSeconds: replay.wallSeconds ?? null, complete: replay.complete === true,
    fullAcceptance: replay.fullAcceptance === true, completedDates: replay.days.length,
    requestedDates: replay.dates.length, failures, invariantFailures: unclassifiedFailures ? null : invariantFailures,
    executionFailures: failures.filter(failure => failure.name && failure.name !== 'AssertionError').length + (replay.triggerFidelity?.unsupportedInputs?.length ?? 0),
    segments: replay.segments ?? [], interruptions: replay.interruptions ?? [],
    defectEvidence: replay.defectEvidence ?? [], datasetEvidence: replay.datasetEvidence ?? [],
    triggerFidelity: replay.triggerFidelity ?? { verified: false },
    acceptanceGaps: replay.acceptanceGaps ?? [],
    withinFiveHours: !replay.complete || replay.wallSeconds == null ? null : replay.wallSeconds <= 18000,
  }
  assert.ok(!summary.fullAcceptance || (summary.complete && !failures.length && !summary.acceptanceGaps.length && summary.triggerFidelity.verified), 'Full acceptance requires complete measured coverage and production triggers')
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

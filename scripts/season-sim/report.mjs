import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { miniRoot, laneDirectory, writeJson } from './common.mjs'
import { countersBelongToRun, summarizeRun, executionNotes } from './report-summary.mjs'
import { verifyTimelineHistory } from './history-checks.mjs'

const evidence = await laneDirectory(path.join(miniRoot, 'evidence'))
const lines = async file => (await readFile(path.join(evidence, file), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const replay = JSON.parse(await readFile(path.join(evidence, 'replay-checkpoint.json'), 'utf8'))
let history = null
if (replay.complete) {
  try { history = await verifyTimelineHistory(replay) }
  catch (error) { replay.failures = [...(replay.failures ?? []), { name: error.name, message: error.message, phase: 'report-history' }]; replay.fullAcceptance = false }
}
const invocations = await lines('edge-invocations.jsonl')
const measured = summarizeRun(replay)
const inRun = invocations.filter(row => row.realAt >= replay.startedAt && row.realAt <= replay.finishedAt)
const functions = {}
for (const name of new Set(inRun.map(row => row.function))) {
  const rows = inRun.filter(row => row.function === name)
  const durations = rows.map(row => row.durationMs).sort((a, b) => a - b)
  functions[name] = { calls: rows.length, errors: rows.filter(row => row.status >= 400).length, totalMs: durations.reduce((sum, value) => sum + value, 0), meanMs: durations.reduce((sum, value) => sum + value, 0) / rows.length, medianMs: durations[Math.floor(rows.length / 2)], p95Ms: durations[Math.min(rows.length - 1, Math.ceil(rows.length * 0.95) - 1)], maximumMs: durations.at(-1) }
}
await writeJson(path.join(evidence, 'job-load-edge-summary.json'), { window: { start: replay.startedAt, end: replay.finishedAt }, functions, raw: 'edge-invocations.jsonl' })
const upstream = JSON.parse(await readFile(path.join(evidence, 'upstream-summary.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '{"classes":{},"paths":{},"measured":false}'; throw error }))
const classes = upstream.classes, sources = upstream.paths
const scopedCounters = countersBelongToRun(upstream, replay)
const counterScope = scopedCounters ? 'Origin counters fall inside this replay window' : 'Origin counters have a wider or unknown window; no per-run totals are inferred'
const actions = (await lines('user-actions.jsonl')).filter(row => row.realAt >= replay.startedAt && row.realAt <= replay.finishedAt)
const routes = {}
for (const row of actions) routes[row.route.replace(/[a-f0-9]{8}-[a-f0-9-]{27}/g, 'ID')] = (routes[row.route.replace(/[a-f0-9]{8}-[a-f0-9-]{27}/g, 'ID')] ?? 0) + 1
await writeJson(path.join(evidence, 'event-coverage.json'), { window: { start: replay.startedAt, end: replay.finishedAt }, fullAcceptance: replay.fullAcceptance, upstreamDeliveriesByClass: scopedCounters ? classes : null, upstreamPaths: scopedCounters ? sources : null, retainedOriginCounterTotals: classes, counterScope, syntheticAuthenticatedRequests: actions.length, actionRoutes: routes, rawSampleRows: upstream.rawSampleRows, rawSampling: `First ${upstream.rawSampleLimit} requests, then every ${upstream.rawSampleEvery}th request; complete counters and game coverage remain in upstream-summary.json` })
const dayClasses = {}
for (const day of replay.days) {
  const group = dayClasses[day.category] ??= { dates: [], games: 0, plannedCheckpoints: 0, minimumLiveSnapshotsPerGame: day.minimumSnapshots, requiredPeriods: day.requiredPeriods, wallSeconds: 0, observedDistinctSnapshots: 0, observedMinimumPerGame: null, observedMaximumPerGame: null }
  group.dates.push(day.date)
  group.games += day.finals.games
  group.plannedCheckpoints += day.plannedCheckpoints
  group.wallSeconds += day.wallSeconds
  for (const count of Object.values(day.coverage.snapshotCounts)) {
    group.observedDistinctSnapshots += count
    group.observedMinimumPerGame = Math.min(group.observedMinimumPerGame ?? count, count)
    group.observedMaximumPerGame = Math.max(group.observedMaximumPerGame ?? count, count)
  }
}
const faults = {}
for (const fault of replay.faults) faults[fault.name] = (faults[fault.name] ?? 0) + 1
const checked = replay.days.reduce((sum, day) => sum + (day.nbaTeams?.checked ?? 0) + (day.domain?.checks ?? 0) + (day.coverage?.checks ?? 0) + (day.finals.players ?? 0) * (day.finals.fieldsPerPlayer ?? 0) + (day.points?.playerGamePoints ?? 0) + 2 * (day.points?.matchups ?? 0) + (day.lineups?.preferenceChecks ?? 0) + (day.lineups?.postLockRejections ?? 0) * 2, 0)
const finalComparisons = (replay.finalAudit ?? []).reduce((sum, day) => sum + day.finals.players * day.finals.fieldsPerPlayer + day.points.playerGamePoints + 2 * day.points.matchups, 0)
const summary = { segments: replay.segments ?? null, interruptions: replay.interruptions ?? [], elapsedIncludingPauseSeconds: replay.elapsedIncludingPauseSeconds ?? replay.wallSeconds, rolloverRecovery: replay.rolloverRecovery ?? null, continuationWaivers: replay.continuationWaivers ?? null, finalAuditComparisons: finalComparisons, finalAuditDates: replay.finalAudit?.length ?? 0, startedAt: replay.startedAt, finishedAt: replay.finishedAt, wallSeconds: replay.wallSeconds, complete: replay.complete, fullAcceptance: replay.fullAcceptance, failure: replay.failure ?? null, invariantFailures: measured.invariantFailures, verifiedGames: replay.days.reduce((sum, day) => sum + day.finals.games, 0), dayClasses, events: replay.events, faults, invariantComparisonsCounted: checked + finalComparisons, countScope: 'Explicit final field comparisons, player-game and matchup points, domain checks, delivery coverage, preference preservation and post-lock rejection/atomicity. Fixture hashes, API status checks and additional scenario assertions are excluded.', actionCases: replay.actions, seasonEnd: replay.seasonEnd, provenance: scopedCounters ? classes : null, counterScope, history }
Object.assign(summary, measured, { source: replay.source ?? null, freshDatabase: replay.freshDatabase ?? null, databaseBefore: replay.databaseBefore ?? null, diagnosticSkippedWeeks: replay.diagnosticSkippedWeeks ?? null, nextSeason: replay.nextSeason ?? null, nextSeasonSchedule: replay.nextSeasonSchedule ?? null, champion: replay.champion ?? null, previousChampion: replay.previousChampion ?? null, rookieAutoPick: replay.rookieAutoPick ?? null, pickAllocation: replay.pickAllocation ?? null, waivers: replay.waivers ?? null, waiverRollover: replay.waiverRollover ?? null, waiverBoundaryDeferrals: replay.waiverBoundaryDeferrals ?? null, sampling: replay.sampling ?? null, liveSamples: replay.liveSamples ?? null, internalLiveSamples: replay.internalLiveSamples ?? null, skippedLiveSamples: replay.skippedLiveSamples ?? null, restoredOverlay: replay.overlay ?? null })
summary.loadScope = 'Database deltas include harness guards and read-only checks. Edge timings cover this run window.'
await writeJson(path.join(evidence, 'final-run.json'), summary)
await writeFile(path.join(evidence, 'final-run.md'), `# Replay result\n\nFull acceptance: ${replay.fullAcceptance}. Completed dates: ${replay.days.length}/${replay.dates.length}.\nWall time: ${replay.wallSeconds} seconds. Counted invariant comparisons: ${checked + finalComparisons}.\n\n${Object.entries(dayClasses).map(([name, group]) => `- ${name}: ${group.dates.length} dates, ${group.games} games, minimum ${group.minimumLiveSnapshotsPerGame} live snapshots per game${group.requiredPeriods ? '; one in each regulation quarter' : ''}.`).join('\n')}\n\nExact dates, fault counts, actions, phase results and failure details: final-run.json.
${executionNotes(replay)}\nDatabase statement counters reset at run start. Table tuple reads use before/after deltas. Edge timings use this run's wall-time window.\n`)
await writeFile(path.join(evidence, 'replay-provenance.md'), `# Replay delivery coverage\n\nWindow: ${replay.startedAt} to ${replay.finishedAt}.\n${counterScope}.\n\nOrigin counter totals:\n${Object.entries(classes).map(([name, count]) => `- ${name}: ${count} upstream deliveries`).join('\n')}\n- SYNTHETIC authenticated action requests: ${actions.length}\n\nDataset evidence measured in this run: ${JSON.stringify(measured.datasetEvidence)}.\nDefect evidence measured in this run: ${JSON.stringify(measured.defectEvidence)}.\n\nKnown input limits are pinned from scripts/season-sim/known-discrepancies.json and scripts/season-sim/known-identities.json, not re-measured by report generation.\n`)
console.log(JSON.stringify(measured))

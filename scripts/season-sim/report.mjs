import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { miniRoot, laneDirectory, writeJson } from './common.mjs'
import { verifyTimelineHistory } from './history-checks.mjs'

const evidence = await laneDirectory(path.join(miniRoot, 'evidence'))
const lines = async file => (await readFile(path.join(evidence, file), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const replay = JSON.parse(await readFile(path.join(evidence, 'replay-checkpoint.json'), 'utf8'))
const history = replay.complete ? await verifyTimelineHistory(replay) : null
const invocations = await lines('edge-invocations.jsonl')
const inRun = invocations.filter(row => row.realAt >= replay.startedAt && row.realAt <= replay.finishedAt)
const functions = {}
for (const name of new Set(inRun.map(row => row.function))) {
  const rows = inRun.filter(row => row.function === name)
  const durations = rows.map(row => row.durationMs).sort((a, b) => a - b)
  functions[name] = { calls: rows.length, errors: rows.filter(row => row.status >= 400).length, totalMs: durations.reduce((sum, value) => sum + value, 0), meanMs: durations.reduce((sum, value) => sum + value, 0) / rows.length, medianMs: durations[Math.floor(rows.length / 2)], p95Ms: durations[Math.min(rows.length - 1, Math.ceil(rows.length * 0.95) - 1)], maximumMs: durations.at(-1) }
}
await writeJson(path.join(evidence, 'job-load-edge-summary.json'), { window: { start: replay.startedAt, end: replay.finishedAt }, functions, raw: 'edge-invocations.jsonl' })
const upstream = JSON.parse(await readFile(path.join(evidence, 'upstream-summary.json'), 'utf8'))
const classes = upstream.classes, sources = upstream.paths
const actions = (await lines('user-actions.jsonl')).filter(row => row.realAt >= replay.startedAt && row.realAt <= replay.finishedAt)
const routes = {}
for (const row of actions) routes[row.route.replace(/[a-f0-9]{8}-[a-f0-9-]{27}/g, 'ID')] = (routes[row.route.replace(/[a-f0-9]{8}-[a-f0-9-]{27}/g, 'ID')] ?? 0) + 1
await writeJson(path.join(evidence, 'event-coverage.json'), { window: { start: replay.startedAt, end: replay.finishedAt }, fullAcceptance: replay.fullAcceptance, upstreamDeliveriesByClass: classes, upstreamPaths: sources, syntheticAuthenticatedRequests: actions.length, actionRoutes: routes, rawSampleRows: upstream.rawSampleRows, rawSampling: `First ${upstream.rawSampleLimit} requests, then every ${upstream.rawSampleEvery}th request; complete counters and game coverage remain in upstream-summary.json` })
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
const summary = { segments: replay.segments ?? null, interruptions: replay.interruptions ?? [], elapsedIncludingPauseSeconds: replay.elapsedIncludingPauseSeconds ?? replay.wallSeconds, rolloverRecovery: replay.rolloverRecovery ?? null, continuationWaivers: replay.continuationWaivers ?? null, finalAuditComparisons: finalComparisons, finalAuditDates: replay.finalAudit?.length ?? 0, startedAt: replay.startedAt, finishedAt: replay.finishedAt, wallSeconds: replay.wallSeconds, withinFourHours: replay.wallSeconds <= 14400, complete: replay.complete, fullAcceptance: replay.fullAcceptance, failure: replay.failure ?? null, invariantFailures: replay.failure ? 1 : 0, verifiedGames: replay.days.reduce((sum, day) => sum + day.finals.games, 0), dayClasses, events: replay.events, faults, invariantComparisonsCounted: checked + finalComparisons, countScope: 'Explicit final field comparisons, player-game and matchup points, domain checks, delivery coverage, preference preservation and post-lock rejection/atomicity. Fixture hashes, API status checks and additional scenario assertions are excluded.', actionCases: replay.actions, seasonEnd: replay.seasonEnd, provenance: classes, history }
summary.backendDefectsFixed = { thisRound: [], earlierAcceptedRounds: ['SIM-B001', 'SIM-B002', 'SIM-B003', 'SIM-B004', 'SIM-B005', 'SIM-B006', 'SIM-B007', 'SIM-B008'], redGreenLedger: 'defects.md' }
summary.loadScope = 'Database deltas include simulator guards and read-only oracles. Edge timings isolate real function handlers. No other project shares this database.'
await writeJson(path.join(evidence, 'final-run.json'), summary)
await writeFile(path.join(evidence, 'final-run.md'), `# Replay result\n\nFull acceptance: ${replay.fullAcceptance}. Completed dates: ${replay.days.length}/${replay.dates.length}.\nWall time: ${replay.wallSeconds} seconds. Counted invariant comparisons: ${checked + finalComparisons}.\n\n${Object.entries(dayClasses).map(([name, group]) => `- ${name}: ${group.dates.length} dates, ${group.games} games, minimum ${group.minimumLiveSnapshotsPerGame} live snapshots per game${group.requiredPeriods ? '; one in each regulation quarter' : ''}.`).join('\n')}\n\nExact dates, fault counts, actions, phase results and failure details: final-run.json.
Active execution time sums the recorded segments. Elapsed time including the pause: ${replay.elapsedIncludingPauseSeconds ?? replay.wallSeconds} seconds.
A driver-only continuation uses the same retained database; interruptions remain recorded in final-run.json.\nDatabase statement counters reset at run start. Table tuple reads use before/after deltas. Edge timings use this run's wall-time window.\n`)
const existing = await readFile(path.join(evidence, 'provenance.md'), 'utf8')
await writeFile(path.join(evidence, 'provenance.md'), `${existing.split('\n## Replay delivery coverage')[0]}\n## Replay delivery coverage\n\nWindow: ${replay.startedAt} to ${replay.finishedAt}. Full acceptance: ${replay.fullAcceptance}.\n\n${Object.entries(classes).map(([name, count]) => `- ${name}: ${count} upstream deliveries`).join('\n')}\n- SYNTHETIC authenticated action requests: ${actions.length}\n\nThe origin counts every request. The raw log keeps a bounded initial sample and periodic samples. Full per-game coverage and class counts remain in upstream-summary.json.\n\nLive minutes and plus-minus derive from real PBP court events. Derived plus-minus differs from official finals across all 1,230 games. Game 0022500093 has minutes differences beyond the 1.1-second audit tolerance. These unresolved live-field differences never exempt the official final oracle. The eight pinned PBP counting-stat discrepancies are natural corrections; all official final fields must win.\n\nGame 0022500232 has 277 actions timestamped after its recorded game end. Final delivery uses the last recorded game-end event plus 60 seconds. Live windows exclude those later-dated actions; no replacement action time is invented. Game 0022500104 has two game-end markers; the last one controls final delivery. See source-time-audit.json for the original records.\n\nThe raw box for 0022500622 assigns Dillon Jones provider ID 196295686. Thirty-eight later boxes use 1641794, including matching team, jersey, and inactive reason in 0022500643. The reviewed SQL correction preserves his existing player UUID and history. The independent oracle pins this one game and refuses new occurrences. provider-identity-audit.json records all source URLs and hashes. One current player-index supplement was fetched for corroboration but does not list him; it is not historical replay input.\n\nHistorical career totals remain unavailable and stay null. Synthetic draft boards supply clearly named invented prospects for taxi eligibility and the rookie draft. Those scenarios prove app behavior but do not prove historical NBA career eligibility. No invented career zero is attached to a real historical player.\n\nThe real calendar has no fantasy week during February 13–18. The commissioner skips the published February 9–12 week. No week zero or All-Star exhibition game is invented.\n\nHistorical injury and postponement announcement times remain unavailable. The derived daily schedule publishes Postponed on the original date and publishes the makeup on the next Eastern date, before a next-day makeup tips off. The injury feed carries each player's latest box observation, including same-date inactive reasons published before tipoff by a declared derived timing policy. Dated game recaps substitute for historical news. Roster bootstrap uses first observed teams for later debuts. Team changes publish on the first observed game date, before tipoff; the historical announcement time is unavailable. Live boxes omit unconsumed CDN fields.\n`)
console.log(JSON.stringify({ fullAcceptance: replay.fullAcceptance, wallSeconds: replay.wallSeconds, invariantComparisonsCounted: checked + finalComparisons, classes }))

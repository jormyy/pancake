import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { digest, directory, json, readJson } from './common.mjs'
import { percentile } from './measure.mjs'

export function distribution(values) {
  return { median: percentile(values, .5), min: Math.min(...values), max: Math.max(...values), spread: Math.max(...values) - Math.min(...values), n: values.length }
}

export function summarize(reports) {
  assert.ok(reports.length >= 3 && reports.every(report => report.passed), 'At least three passing baseline runs are required')
  assert.equal(new Set(reports.map(report => report.fixtureSha256)).size, 1, 'Frozen fixture differs across runs')
  assert.equal(new Set(reports.map(report => report.memoryMiB)).size, 1, 'Memory caps differ across runs')
  const metrics = {
    swapInPagesPerSecond: report => report.swap.inPagesPerSecond,
    swapOutPagesPerSecond: report => report.swap.outPagesPerSecond,
    swapTotalPagesPerSecond: report => report.swap.inPagesPerSecond + report.swap.outPagesPerSecond,
    cgroupAnonRefaultsPerSecond: report => report.swap.cgroupAnonRefaultsPerSecond,
    cgroupSwapPeakBytes: report => report.swap.cgroupSwapPeakBytes,
    cgroupMajorFaultsPerSecond: report => report.memory.majorFaults / report.seconds,
    cgroupAnonPeakBytes: report => report.memory.cgroupAnonPeakBytes,
    cgroupShmemPeakBytes: report => report.memory.cgroupShmemPeakBytes,
    walBytesPerMinute: report => report.walBytesPerMinute,
    newSessionsPerMinute: report => report.newSessionsPerMinute,
    cronRunsPerMinute: report => report.cronRunsPerMinute,
    scoreFreshnessP95Ms: report => report.scoreFreshness.p95Ms,
  }
  const summary = { n: reports.length, source: reports[0].source, fixtureSha256: reports[0].fixtureSha256, memoryMiB: reports[0].memoryMiB,
    runs: reports.map(report => report.label), metrics: Object.fromEntries(Object.entries(metrics).map(([name, get]) => [name, distribution(reports.map(get))])),
    workCounts: reports.map(report => ({ run: report.label, ...report.workCounts })),
    workerRunsPerHourByKind: {}, statementFunctions: [], limitations: [
      'Swap counters cover the entire Docker VM. Other activity can contaminate them.',
      'Anonymous memory is the largest five-second cgroup sample, not an exact kernel peak.',
      'Statement totals include nested calls. Function groups can overlap and do not sum to wall-clock work.',
      'Read blocks rank possible memory and swap pressure. They do not prove causal memory or swap use by function.',
      'This is synthetic local evidence. It is not production proof.',
    ] }
  const names = new Set(reports.flatMap(report => report.statementExecSecondsPerMinuteByFunction.map(row => row.function)))
  summary.statementFunctions = [...names].map(name => {
    const rows = reports.map(report => report.statementExecSecondsPerMinuteByFunction.find(row => row.function === name) ?? { calls: 0, execSecondsPerMinute: 0, walBytesPerMinute: 0, reads: 0 })
    return { function: name, calls: distribution(rows.map(row => row.calls)), execSecondsPerMinute: distribution(rows.map(row => row.execSecondsPerMinute)), walBytesPerMinute: distribution(rows.map(row => row.walBytesPerMinute)), readBlocks: distribution(rows.map(row => row.reads)) }
  }).sort((a, b) => b.execSecondsPerMinute.median - a.execSecondsPerMinute.median)
  for (const kind of new Set(reports.flatMap(report => Object.keys(report.workerRunsPerHourByKind)))) summary.workerRunsPerHourByKind[kind] = distribution(reports.map(report => report.workerRunsPerHourByKind[kind] ?? 0))
  summary.rankedCosts = {
    memory: [
      { category: 'anonymous backend memory', peakBytes: summary.metrics.cgroupAnonPeakBytes },
      { category: 'shared memory', peakBytes: summary.metrics.cgroupShmemPeakBytes },
    ].sort((a, b) => b.peakBytes.median - a.peakBytes.median),
    swap: { vmInPagesPerSecond: summary.metrics.swapInPagesPerSecond, vmOutPagesPerSecond: summary.metrics.swapOutPagesPerSecond, databaseAnonRefaultsPerSecond: summary.metrics.cgroupAnonRefaultsPerSecond, databaseSwapPeakBytes: summary.metrics.cgroupSwapPeakBytes, attribution: 'VM rates are contextual. Cgroup refaults and swap occupancy belong to the database container.' },
    memoryAndSwapPressureProxy: [...summary.statementFunctions].sort((a, b) => b.readBlocks.median - a.readBlocks.median).slice(0, 12),
    wal: [...summary.statementFunctions].sort((a, b) => b.walBytesPerMinute.median - a.walBytesPerMinute.median).slice(0, 12),
    sessionChurn: { sessionsPerMinute: summary.metrics.newSessionsPerMinute, cronRunsPerMinute: summary.metrics.cronRunsPerMinute, attribution: 'Cron starts one backend per invocation; pooled PostgREST sessions persist. Per-client samples show live pool size, not cumulative session starts.' },
  }
  summary.noise = Math.max(summary.metrics.swapTotalPagesPerSecond.spread, summary.metrics.swapTotalPagesPerSecond.median * .05)
  return summary
}

export async function hypotheses(evidence, summary) {
  const healthcheck = await readJson(path.join(evidence, 'database-healthcheck.json'))
  const healthchecksPerMinute = 60e9 / healthcheck.Interval
  summary.rankedCosts.sessionChurn.labHealthchecksPerMinute = healthchecksPerMinute
  summary.rankedCosts.sessionChurn.remainingSessionsPerMinute = Math.max(0, summary.metrics.newSessionsPerMinute.median - healthchecksPerMinute - summary.metrics.cronRunsPerMinute.median)
  summary.rankedCosts.sessionChurn.attribution = 'Docker pg_isready health checks create sessions. The recorded interval gives their expected rate. Cron creates one backend per run; the remainder includes pooled API churn and other clients.'
  summary.limitations.push('New sessions include Docker health probes. Their expected rate is separated from application costs.')
  await json(path.join(evidence, 'baseline-summary.json'), summary)
  await json(path.join(evidence, 'postprocessor.json'), { summarySha256: digest(await readFile(path.join(directory, 'summary.mjs'))), purpose: 'Separate measured lab health-check sessions from application costs without changing the replay workload.' })
  const readRank = summary.rankedCosts.memoryAndSwapPressureProxy.map((row, n) => `${n + 1}. ${row.function}: ${row.readBlocks.median} median read blocks; ${row.execSecondsPerMinute.median.toFixed(4)} execution seconds per minute.`).join('\n')
  const walRank = summary.rankedCosts.wal.map((row, n) => `${n + 1}. ${row.function}: ${Math.round(row.walBytesPerMinute.median)} median WAL bytes per minute.`).join('\n')
  const memoryRank = summary.rankedCosts.memory.map((row, n) => `${n + 1}. ${row.category}: ${(row.peakBytes.median / 1048576).toFixed(1)} MiB median sampled peak.`).join('\n')
  const text = `# Baseline cost hypotheses

These are candidates for later experiments. This lab changes no product behavior.
Read blocks rank possible memory and swap pressure. They do not assign swap pages to functions.
Nested statement WAL is inclusive. Use the global WAL counter for total volume.

## Measured memory and swap

${memoryRank}

The database reaches ${(summary.metrics.cgroupSwapPeakBytes.median / 1048576).toFixed(1)} MiB median swap occupancy and ${summary.metrics.cgroupAnonRefaultsPerSecond.median.toFixed(1)} anonymous refaults per second.
VM swap rates are contextual because other containers share the host.
The separate peaks occur at different times. Do not add them as simultaneous memory use.

## Measured memory and swap pressure proxies

${readRank}

## Measured WAL costs

${walRank}

## Measured session churn

New sessions: ${summary.metrics.newSessionsPerMinute.median.toFixed(2)} per minute.
Docker health probes: ${healthchecksPerMinute.toFixed(2)} expected sessions per minute, from the recorded probe interval.
Cron runs: ${summary.metrics.cronRunsPerMinute.median.toFixed(2)} per minute.
Remaining new sessions: ${summary.rankedCosts.sessionChurn.remainingSessionsPerMinute.toFixed(2)} per minute, after these known sources.
Compare cron forks with persistent PostgREST pools in each report's client samples.
The Docker probe cost belongs to this lab. Do not rank it as a product regression.

## Candidates

| Path | Possible change | Required proof |
| --- | --- | --- |
| 20-second live tick and per-game saves | Use public thirty-second snapshots with official checkpoints; test sixty seconds only as a named limit variant. | Preserve final correction and the 45-second phone freshness gate at the default cadence. |
| resolve_player_imports_atomic | Cache verified identities within an invocation. | Preserve conflict checks and unknown-player imports. |
| assert_nba_game_unambiguous | Reuse identity proofs until relevant inputs change. | Keep ambiguity rejection and concurrent-change protection. |
| refresh-views and scheduler chunks | Coalesce dirty work and reuse shared reads. | Preserve cursors, queues, and saved-screen freshness. |
| Forecasts | Reuse inputs and defer repeated dirty recomputations. | Keep the approved thirty-minute cycle and final update. |
| Cron frequency and backend forks | Test fewer empty dispatches or a persistent scheduler connection. | Preserve waivers, deadlines, leases, and recovery. |
| Pooled PostgREST connections | Test smaller idle pools and bounded active workers. | Measure peak latency and queue growth. |
| Realtime sends | Coalesce equal hints and count subscribers. | Preserve authenticated delivery and revisions. |
| Redundant player_game_stats indexes | Compare overlapping keys and actual reads before removal. | Keep uniqueness and plans for all retained queries. |
| Per-row score triggers | Aggregate changed scopes once per statement. | Preserve transaction publication and score certificates. |
| Memory settings | Test shared_buffers, work_mem, maintenance_work_mem, and backend limits separately. | Keep the same cgroup, slate, job rates, and correctness gates. |

Use interleaved baseline and candidate runs. Treat changes within the recorded noise as inconclusive.
The frozen held-out slate remains outside tuning.
`
  await writeFile(path.join(evidence, 'hypotheses.md'), text)
}

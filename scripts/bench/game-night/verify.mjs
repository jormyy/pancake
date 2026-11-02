import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { command, defaultEvidence, readJson } from './common.mjs'
import { statementDeltas } from './measure.mjs'

export async function verifyEvidence(evidence = defaultEvidence) {
  let checks = 0
  const check = (value, message) => { assert.ok(value, message); checks++ }
  const summary = await readJson(path.join(evidence, 'baseline-summary.json'))
  check(summary.n >= 3 && summary.runs.length === summary.n, 'Baseline n must be at least three')
  for (const name of summary.runs) {
    const report = await readJson(path.join(evidence, `${name}.json`))
    check(report.passed && report.finalState.passed && report.workCounts.passed, `${name}: quality gates must pass`)
    check(report.finalState.games === 7 && report.finalState.statRows === 168 && report.finalState.fantasyMatchups === 5, `${name}: final fixture coverage`)
    check(report.shape.players === 2600 && report.shape.teams === 10 && report.shape.stats === 246000, `${name}: population shape`)
    check(report.shape.databaseBytes >= 250000000 && report.shape.databaseBytes <= 280000000, `${name}: database allocation must approximate 265 MB`)
    const delta = statementDeltas(report.before.statements, report.after.statements)
    check(delta.some(row => row.function === 'save_live_feed_snapshot_atomic' && row.calls > 0), `${name}: raw timed counters must show stat saves`)
    const starts = report.after.invocations.filter(row => Date.parse(row.worker_started_at) >= Date.parse(report.startedAt) && Date.parse(row.worker_started_at) < Date.parse(report.endedAt))
    check(starts.some(row => row.function_name === 'live-poll'), `${name}: a real live worker must start inside the window`)
    check(report.realtime.subscribed && report.realtime.messages > 0, `${name}: Realtime must receive actual broadcasts`)
    check(report.scoreFreshness.samples > 0 && report.scoreFreshness.fantasySamples > 0, `${name}: score freshness needs observed changes`)
    check(report.deadWorkItems.length === 0 && Object.values(report.failures).every(rows => rows.length === 0), `${name}: no job failures or dead work`)
  }
  const broken = await readJson(path.join(evidence, 'control-broken-final.json'))
  check(!broken.finalState.passed && broken.finalState.failures.length > 0 && broken.workCounts.passed, 'Dropped-stat control must fail final state while doing real work')
  const off = await readJson(path.join(evidence, 'control-ingestion-off.json'))
  check(!off.workCounts.passed && off.workCounts.saved === 0 && off.workCounts.cronRuns > 0, 'No-ingestion control must fail while cron runs')
  const heldout = await readJson(path.join(evidence, 'held-out-baseline.json'))
  check(heldout.passed && heldout.finalState.games === 12 && heldout.finalState.statRows === 288, 'Held-out fixture must pass')
  const calibration = await readJson(path.join(evidence, 'calibration.json'))
  check(calibration.runs.length > 0 && calibration.selectedMemoryMiB === summary.memoryMiB, 'Calibration must select the baseline cap')
  check(calibration.nearTarget || typeof calibration.limitation === 'string' && calibration.limitation.length > 0, 'Unmatched swap needs an explicit limitation')
  const cleanup = await readJson(path.join(evidence, 'cleanup.json'))
  check(cleanup.stopped, 'Stack cleanup must succeed')
  const containers = await command('docker', ['ps', '-aq', '--filter', `label=com.supabase.cli.project=${cleanup.project}`])
  check(containers.stdout.trim() === '', 'No disposable containers may remain')
  return { passed: true, checks, n: summary.n, capMiB: summary.memoryMiB, calibratedNearTarget: calibration.nearTarget }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await verifyEvidence(process.argv[2] ?? defaultEvidence)))
}

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { requireMini, project } from '../../scripts/perf-lab/common.mjs'

await requireMini()
assert.equal(project, 'pt4bafablel1')
const [label, profile] = process.argv.slice(2)
assert.match(label ?? '', /^[a-z0-9-]+$/)
assert.ok(['inventory', 'idle', 'live'].includes(profile))
const directory = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-l1/evidence')
const modes = ['postgres', 'broadcast']
const reports = Object.fromEntries(await Promise.all(modes.map(async mode => [mode, await Promise.all(
  Array.from({ length: 5 }, async (_, index) => {
    const report = JSON.parse(await readFile(path.join(directory, `${label}-${profile}-${mode}-${index + 1}.json`), 'utf8'))
    assert.equal(report.status, 'complete')
    assert.equal(report.devices, profile === 'live' ? 20 : 3)
    assert.ok((profile === 'idle' ? [120, 900] : profile === 'live' ? [300, 1800] : [60]).includes(report.seconds))
    assert.equal(report.apiErrors, 0)
    assert.equal(report.missing.length, 0)
    assert.equal(report.disconnects, 0)
    if (report.concurrentLanes) assert.equal(report.readinessProbeDelivered, report.devices)
    if (profile !== 'inventory') {
      assert.equal(report.infrastructureBefore.length, 5)
      assert.deepEqual(report.infrastructureBefore, report.infrastructureAfter)
      assert.equal(report.writes, profile === 'idle' ? 0 : Math.ceil(report.seconds * 1000 / (report.writeIntervalMs ?? 2000)))
      if (profile === 'live') {
        assert.equal(report.fallbackPollMs, 20000)
        assert.ok(report.liveGameId)
        assert.ok(report.versionRequests >= 14 * (Math.floor(report.seconds / 20) - 2))
      }
    }
    assert.equal(report.latencies.length, profile === 'idle' ? report.devices : report.writes * report.devices)
    if (profile === 'idle') assert.equal(report.idleProbeDelivered, 3)
    return report
  }),
)])))
const statistics = values => {
  assert.ok(values.every(value => typeof value === 'number' && Number.isFinite(value)))
  const sorted = values.toSorted((a, b) => a - b)
  return { median: sorted[2], min: sorted[0], max: sorted[4], spread: sorted[4] - sorted[0] }
}
assert.equal(new Set(modes.flatMap(mode => reports[mode].map(report => report.seconds))).size, 1)
assert.equal(new Set(modes.flatMap(mode => reports[mode].map(report => report.writeIntervalMs ?? 2000))).size, 1)
const fields = {
  realtimeDbMsPerMinute: report => report.realtime.dbMsPerMinute,
  realtimeCallsPerMinute: report => report.realtime.callsPerMinute,
  realtimeBuffersPerMinute: report => report.realtime.buffersPerMinute,
  totalDbMsPerMinute: report => report.total.dbMsPerMinute,
  totalCallsPerMinute: report => report.total.callsPerMinute,
  buffersPerMinute: report => report.total.buffersPerMinute,
  dbCpuSecondsPerMinute: report => report.dbCpuSecondsPerMinute,
  realtimeCpuSecondsPerMinute: report => report.realtimeCpuSecondsPerMinute,
  walBytesPerMinute: report => report.walBytesPerMinute,
  walInsertBytesPerMinute: report => report.walInsertBytesPerMinute,
  walFullPageImagesPerMinute: report => report.walFullPageImagesPerMinute,
  socketBytesPerMinute: report => report.socketBytesPerMinute,
  apiBytesPerMinute: report => report.apiBytes / report.minutes,
  messages: report => report.messages,
  writes: report => report.writes,
  p50Ms: report => report.p50Ms,
  p95Ms: report => report.p95Ms,
}
if (profile !== 'inventory') {
  fields.wireMessages = report => report.wireMessages
  fields.versionRequests = report => report.versionRequests
}
if (reports.postgres.every(report => report.concurrentLanes)) {
  Object.assign(fields, {
    walPollCallsPerMinute: report => report.walPoll.callsPerMinute,
    walPollBuffersPerMinute: report => report.walPoll.buffersPerMinute,
    authorizeCallsPerMinute: report => report.authorize.callsPerMinute,
    authorizationContextCallsPerMinute: report => report.authorizationContext.callsPerMinute,
    catalogCallsPerMinute: report => report.catalog.callsPerMinute,
    callsPerClientMinute: report => report.callsPerClientMinute,
    socketBytesPerClientMinute: report => report.socketBytesPerMinute / report.devices,
    apiBytesPerClientMinute: report => report.apiBytes / report.minutes / report.devices,
    walBytesPerClientMinute: report => report.walBytesPerMinute / report.devices,
    edgeRequestsPerClientMinute: report => report.edgeRequests / report.minutes / report.devices,
    setupRetries: report => report.setupRetries.length,
    joinsPerClientMinute: report => report.joins / report.minutes / report.devices,
    joinErrors: report => report.joinErrors,
  })
}
const metrics = Object.fromEntries(Object.entries(fields).map(([field, read]) => {
  const before = reports.postgres.map(read), after = reports.broadcast.map(read)
  const baseline = statistics(before), candidate = statistics(after)
  const reduction = statistics(before.map((value, index) => value - after[index]))
  return [field, { before: baseline, after: candidate, pairedReduction: reduction, pairedDifferences: after.map((value, index) => value - before[index]),
    clearsNoiseFloor: reduction.median > Math.max(baseline.spread, candidate.spread, baseline.median * 0.1) }]
}))
const result = { label, profile, pairs: 5, seconds: reports.postgres[0].seconds, writeIntervalMs: reports.postgres[0].writeIntervalMs ?? 2000, metrics,
  concurrentLanes: reports.postgres.every(report => report.concurrentLanes), measurementLock: false,
  rateStability: Object.fromEntries(modes.map(mode => [mode, reports[mode].map(report => ({ label: report.label, halves: report.halves ?? null }))])),
  messagesDelivered: Object.fromEntries(modes.map(mode => [mode, reports[mode].reduce((sum, report) => sum + report.messages, 0)])),
  idleProbeDelivered: profile === 'idle' ? Object.fromEntries(modes.map(mode => [mode, reports[mode].reduce((sum, report) => sum + report.idleProbeDelivered, 0)])) : null,
  latencyRegression: metrics.p50Ms.after.median > metrics.p50Ms.before.median || metrics.p95Ms.after.median > metrics.p95Ms.before.median }
await writeFile(path.join(directory, `${label}-${profile}-summary.json`), JSON.stringify(result, null, 2), { mode: 0o600 })
console.log(JSON.stringify(result, null, 2))

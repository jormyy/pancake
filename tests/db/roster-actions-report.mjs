import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0
}

export function summary(samples) {
  const stat = field => {
    const values = samples.map(sample => sample[field] ?? 0)
    const median = percentile(values, 0.5)
    return { p50: median, p95: percentile(values, 0.95), min: Math.min(...values), max: Math.max(...values), spread: median ? (Math.max(...values) - Math.min(...values)) / median : 0 }
  }
  return { calls: samples.length, ...Object.fromEntries(['ms', 'buffers', 'wal', 'statements', 'rowsWritten', 'responseBytes', 'triggerCalls', 'publishes', 'versionMs', 'refreshMs', 'notificationMs', 'bookkeepingMs', 'bookkeepingCalls'].map(field => [field, stat(field)])) }
}

export function compare(before, after) {
  assert.ok(before.calls >= 5 && after.calls >= 5)
  return Object.fromEntries(['ms', 'buffers', 'wal', 'statements'].map(field => {
    const threshold = Math.max(0.1, before[field].spread)
    const gain = before[field].p50 ? 1 - after[field].p50 / before[field].p50 : 0
    return [field, { threshold, gain, passes: gain > threshold }]
  }))
}

export function pairedTime(samples) {
  const pairs = new Map()
  for (const sample of samples) {
    const key = `${sample.name}/${sample.manager}/${sample.round}/${sample.phase}`
    const pair = pairs.get(key) ?? {}
    pair[sample.variant] = sample.ms
    pairs.set(key, pair)
  }
  const complete = [...pairs.values()].filter(pair => pair.baseline > 0 && pair.candidate !== undefined)
  assert.ok(complete.length >= 5)
  const gains = complete.map(pair => 1 - pair.candidate / pair.baseline)
  const differences = complete.map(pair => pair.candidate - pair.baseline)
  const gain = percentile(gains, 0.5)
  const threshold = Math.max(0.1, Math.max(...gains) - Math.min(...gains))
  return { pairs: complete.length, differenceP50: percentile(differences, 0.5), differenceP95: percentile(differences, 0.95), gain, threshold, passes: gain > threshold }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2)
  const raw = JSON.parse(await readFile(input, 'utf8'))
  const samples = raw.map(sample => {
    const statements = sample.statements.filter(statement => !statement.toplevel)
    const functions = sample.functions ?? []
    const selfTime = pattern => functions.filter(fn => pattern.test(fn.name)).reduce((sum, fn) => sum + fn.selfMs, 0)
    return { name: sample.name, manager: sample.manager, round: sample.round, variant: sample.variant, phase: sample.phase, ms: sample.ms, hits: sample.hits, reads: sample.reads, buffers: sample.hits + sample.reads, wal: sample.wal, responseBytes: sample.responseBytes,
      statements: statements.reduce((sum, statement) => sum + statement.calls, 0), rowsWritten: sample.writes,
      triggerCalls: functions.filter(fn => fn.trigger ?? /trigger|prevent_|guard_|enforce_|league_version_capture|sync_roster_linked|set_waiver_clears/.test(fn.name)).reduce((sum, fn) => sum + fn.calls, 0),
      publishes: functions.filter(fn => fn.name === 'publish_league_version').reduce((sum, fn) => sum + fn.calls, 0),
      versionMs: selfTime(/league_version|emit_league_change|emit_league_inventory|publish_league_inventory/), refreshMs: selfTime(/refresh|enqueue_work|work_enqueue|work_capture|queue_.*forecast/), notificationMs: selfTime(/notif/), bookkeepingMs: selfTime(/^(start_edge_invocation|finish_edge_invocation|renew_work_lease|work_finish|work_enforce_lease)$/), bookkeepingCalls: functions.filter(fn => /^(start_edge_invocation|finish_edge_invocation|renew_work_lease|work_finish|work_enforce_lease)$/.test(fn.name)).reduce((sum, fn) => sum + fn.calls, 0), functions: functions.filter(fn => fn.calls) }
  })
  const grouped = []
  for (const name of [...new Set(samples.map(sample => sample.name))]) for (const phase of ['fresh', 'warm']) {
    const before = summary(samples.filter(sample => sample.name === name && sample.phase === phase && sample.variant === 'baseline'))
    const after = summary(samples.filter(sample => sample.name === name && sample.phase === phase && sample.variant === 'candidate'))
    grouped.push({ name, phase, before, after, comparison: { ...compare(before, after), ms: pairedTime(samples.filter(sample => sample.name === name && sample.phase === phase)) } })
  }
  await writeFile(output, JSON.stringify({ concurrentWithOtherLanes: true, samples, grouped }, null, 2))
  console.log(JSON.stringify(grouped.map(row => ({ name: row.name, phase: row.phase, ms: [row.before.ms.p50, row.after.ms.p50], buffers: [row.before.buffers.p50, row.after.buffers.p50], passes: Object.values(row.comparison).some(metric => metric.passes) })), null, 2))
}

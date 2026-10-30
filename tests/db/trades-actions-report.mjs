import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function compareActionResults(before, after) {
  assert.equal(after.response, before.response, 'Action response bytes changed')
  assert.deepEqual(after.rows, before.rows, 'Touched table rows changed')
}

export function nestedPlans(source) {
  const rows = []
  const pattern = /duration: ([\d.]+) ms\s+plan:\s*/g
  for (let match; (match = pattern.exec(source));) {
    const start = pattern.lastIndex
    if (source[start] !== '{') continue
    let depth = 0, quoted = false, escaped = false, end = start
    for (; end < source.length; end++) {
      const char = source[end]
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
      } else if (char === '"') quoted = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) { end++; break }
    }
    if (depth) continue
    const document = JSON.parse(source.slice(start, end))
    rows.push({ milliseconds: Number(match[1]), ...document })
    pattern.lastIndex = end
  }
  return rows
}

export function aggregate(results) {
  const groups = new Map()
  const percentile = (values, value) => [...values].sort((a, b) => a - b)[Math.ceil(value * values.length) - 1]
  for (const result of results) {
    const key = `${result.name}/${result.variant}/${result.warm ? 'warm' : 'fresh'}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(result.metrics)
  }
  return [...groups].map(([key, samples]) => {
    assert.ok(samples.length >= 5, `Five samples required for ${key}`)
    const values = samples.map(sample => sample.milliseconds)
    const med = name => percentile(samples.map(sample => sample[name]), 0.5)
    const functionNames = [...new Set(samples.flatMap(sample => Object.keys(sample.functionCosts ?? {})))]
    const functionCosts = Object.fromEntries(functionNames.map(name => [name, Object.fromEntries(['calls', 'self', 'total'].map(field => [field, percentile(samples.map(sample => sample.functionCosts?.[name]?.[field] ?? 0), 0.5)]))]))
    const tableNames = [...new Set(samples.flatMap(sample => Object.keys(sample.tableWrites ?? {})))]
    const tableWrites = Object.fromEntries(tableNames.map(name => [name, Object.fromEntries(['insert', 'update', 'delete'].map(field => [field, percentile(samples.map(sample => sample.tableWrites?.[name]?.[field] ?? 0), 0.5)]))]))
    const costShares = { publication: 0, refresh: 0, notifications: 0, queueAndBookkeeping: 0 }
    for (const [name, cost] of Object.entries(functionCosts)) {
      if (/publish_league_version|league_version_|queue_trade_publication|defer_trade_event|emit_league|publish_league|publish_asset/.test(name)) costShares.publication += cost.self
      else if (/refresh|queue.*forecast/.test(name)) costShares.refresh += cost.self
      else if (/notif/.test(name)) costShares.notifications += cost.self
      else if (/edge_invocation|renew_work_lease|work_(enforce|finish|enqueue|capture)/.test(name)) costShares.queueAndBookkeeping += cost.self
    }
    return { key, samples: samples.length, calls: med('calls'), statements: med('statements'), p50: percentile(values, 0.5), p95: percentile(values, 0.95),
      spread: (Math.max(...values) - Math.min(...values)) / Math.max(percentile(values, 0.5), 0.000001),
      hits: med('hits'), reads: med('reads'), wal: med('wal'), bytes: med('bytes'),
      writes: samples[0].writes, followups: samples[0].followups, functionCosts, tableWrites, costShares, triggerCalls: med('triggerCalls') }
  })
}

export function paired(results, controls = []) {
  const percentile = (values, value) => [...values].sort((a, b) => a - b)[Math.ceil(value * values.length) - 1]
  const groups = new Map()
  for (const result of results) {
    const key = `${result.name}/${result.warm ? 'warm' : 'fresh'}`
    const group = groups.get(key) ?? new Map()
    const pairKey = `${result.manager}/${result.round}`
    const pair = group.get(pairKey) ?? {}
    assert.equal(pair[result.variant], undefined, `Duplicate comparison sample: ${key}/${pairKey}`)
    pair[result.variant] = result.metrics
    group.set(pairKey, pair)
    groups.set(key, group)
  }
  return [...groups].map(([key, rows]) => {
    const pairs = [...rows.values()]
    assert.ok(pairs.length >= 5, `Five pairs required for ${key}`)
    assert.ok(pairs.every(row => row.baseline && row.candidate), `Incomplete comparison pair for ${key}`)
    const before = pairs.map(row => row.baseline.milliseconds)
    const differences = pairs.map(row => row.candidate.milliseconds - row.baseline.milliseconds)
    const median = percentile(differences, 0.5)
    const deviation = percentile(differences.map(value => Math.abs(value - median)), 0.95)
    const matching = controls.filter(row => `${row.name}/${row.warm ? 'warm' : 'fresh'}` === key)
    const controlPairs = new Map()
    for (const row of matching) {
      const pair = controlPairs.get(`${row.manager}/${row.round}`) ?? {}
      pair[row.variant] = row.metrics.milliseconds
      controlPairs.set(`${row.manager}/${row.round}`, pair)
    }
    const noise = [...controlPairs.values()].filter(pair => pair.baseline != null && pair.candidate != null).map(pair => Math.abs(pair.candidate - pair.baseline))
    const threshold = Math.max(percentile(before, 0.5) * 0.1, deviation, noise.length ? percentile(noise, 0.95) : 0)
    const load = Object.fromEntries(['statements', 'hits', 'reads', 'wal', 'bytes'].map(metric => {
      const a = pairs.map(row => row.baseline[metric]), b = pairs.map(row => row.candidate[metric])
      const initial = percentile(a, 0.5), final = percentile(b, 0.5)
      const noise = Math.max(0.1, (Math.max(...a) - Math.min(...a)) / Math.max(initial, 1))
      return [metric, { before: initial, after: final, saved: initial - final, noise, gain: initial > 0 && (initial - final) / initial > noise }]
    }))
    const buffersBefore = pairs.map(row => row.baseline.hits + row.baseline.reads)
    const buffersAfter = pairs.map(row => row.candidate.hits + row.candidate.reads)
    const initial = percentile(buffersBefore, 0.5), final = percentile(buffersAfter, 0.5)
    const bufferNoise = Math.max(0.1, (Math.max(...buffersBefore) - Math.min(...buffersBefore)) / Math.max(initial, 1))
    return { key, pairs: pairs.length, pairedDifferenceP50: median, pairedDifferenceP95: percentile(differences, 0.95), timingNoise: threshold,
      timeGain: -median > threshold && differences.filter(value => value < 0).length >= Math.ceil(pairs.length * 0.8),
      load: { ...load, buffers: { before: initial, after: final, saved: initial - final, noise: bufferNoise, gain: initial > 0 && (initial - final) / initial > bufferNoise } } }
  })
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2)
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
  const results = JSON.parse(readFileSync(args[0], 'utf8'))
  const controlFile = option('--controls', null)
  const controls = controlFile ? JSON.parse(readFileSync(controlFile, 'utf8')) : []
  const report = { concurrentWithOtherLanes: true, aggregates: aggregate(results), comparisons: paired(results, controls) }
  writeFileSync(option('--output', 'tests/db/trades-actions-results.json'), `${JSON.stringify(report, null, 2)}\n`)
  for (const row of report.comparisons) console.log(JSON.stringify(row))
}

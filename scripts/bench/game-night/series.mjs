import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { json, readJson } from './common.mjs'
import { distribution, summarize } from './summary.mjs'
import { resourceGraderVersion } from './resource-grade.mjs'

const actionNames = ['rosterMove','lineupSave','tradeOffer','tradeAccept','waiverResult']

export function actionLimits(reports) {
  assert.ok(reports.length >= 3, 'Three baseline action runs are required')
  return Object.fromEntries(actionNames.map(name => {
    const rows = reports.map(report => report.actionResults?.records.find(row => row.name === name))
    assert.ok(rows.every(row => row?.passed && Number.isFinite(row.latencyMs)), `Missing successful baseline action: ${name}`)
    const times = distribution(rows.map(row => row.latencyMs))
    return [name, Math.ceil(times.max + Math.max(times.spread, times.median * .05))]
  }))
}

export function compareSeries(baselines, candidates) {
  const baseline = summarize(baselines, { reference: true })
  const candidate = summarize(candidates)
  assert.ok([...baselines,...candidates].every(report=>report.resources?.version===resourceGraderVersion),'Resource grader versions differ')
  assert.equal(candidate.fixtureSha256, baseline.fixtureSha256, 'Baseline and candidate fixtures differ')
  assert.equal(candidate.memoryMiB, 192, 'The candidate must use the fixed 192 MiB cap')
  assert.equal(candidate.memoryMiB, baseline.memoryMiB, 'Baseline and candidate caps differ')
  assert.equal(new Set([...baselines,...candidates].map(report => report.harnessSha256)).size, 1, 'The measurement harness changes within the comparison')
  for (const rows of [baselines,candidates]) {
    assert.equal(new Set(rows.map(report => report.source)).size, 1, 'The source commit changes within a series')
    assert.equal(new Set(rows.map(report => JSON.stringify(report.runtimeConfiguration))).size, 1, 'Runtime settings change within a series')
  }
  assert.ok([...baselines,...candidates].every(report => report.resources?.hostMemory.passed), 'Host memory pressure invalidates this comparison')
  const limits = actionLimits(baselines)
  const actions = candidates.flatMap(report => actionNames.map(name => {
    const row = report.actionResults?.records.find(item => item.name === name)
    return { run: report.label, name, latencyMs: row?.latencyMs ?? null, limitMs: limits[name], passed: Boolean(row?.passed && row.latencyMs <= limits[name]) }
  }))
  const gain = baseline.metrics.cgroupAnonRefaultsPerSecond.median - candidate.metrics.cgroupAnonRefaultsPerSecond.median
  const noise = Math.max(baseline.metrics.cgroupAnonRefaultsPerSecond.spread, baseline.metrics.cgroupAnonRefaultsPerSecond.median * .05)
  const targetPagesPerSecond = Math.min(61, baseline.metrics.cgroupAnonRefaultsPerSecond.median * .05)
  const trainingTarget = candidate.metrics.cgroupAnonRefaultsPerSecond.median <= targetPagesPerSecond
  const quality = candidates.every(report => report.quality?.passed && report.quality.gates.injuries.passed && report.quality.gates.forecasts.passed) && actions.every(row => row.passed)
  return { version: 'game-night-comparison-v3', baseline, candidate, limits, actions, targetPagesPerSecond, baselineQualityPassed: baseline.quality.passed, gainPagesPerSecond: gain, gainFraction: gain / baseline.metrics.cgroupAnonRefaultsPerSecond.median,
    noisePagesPerSecond: noise, exceedsNoise: gain > noise, trainingTarget, quality,
    passed: gain > noise && trainingTarget && quality }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { baseline: { type: 'string', multiple: true }, candidate: { type: 'string', multiple: true }, output: { type: 'string' }, help: { type: 'boolean' } } })
  if (values.help) console.log('Usage: node scripts/bench/game-night/series.mjs --baseline REPORT (at least three) --candidate REPORT (at least three) --output DIRECTORY')
  else {
    assert.ok(values.output && values.baseline?.length && values.candidate?.length, 'Baseline reports, candidate reports, and output are required')
    const result = compareSeries(await Promise.all(values.baseline.map(readJson)), await Promise.all(values.candidate.map(readJson)))
    await json(path.join(values.output, 'baseline-summary.json'), result.baseline)
    await json(path.join(values.output, 'candidate-summary.json'), result.candidate)
    await json(path.join(values.output, 'action-limits.json'), result.limits)
    await json(path.join(values.output, 'comparison.json'), result)
    console.log(JSON.stringify({ passed: result.passed, gainFraction: result.gainFraction, baseline: result.baseline.metrics.cgroupAnonRefaultsPerSecond, candidate: result.candidate.metrics.cgroupAnonRefaultsPerSecond, quality: result.quality }))
  }
}

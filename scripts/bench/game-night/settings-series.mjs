import assert from 'node:assert/strict'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { appendFile } from 'node:fs/promises'
import { command, delay, directory, json, readJson, repository } from './common.mjs'
import { startStack } from './stack.mjs'
import { configurePool } from './pool.mjs'
import { runWindow } from './experiment.mjs'
import { actionLimits, compareSeries } from './series.mjs'

const { values } = parseArgs({ options: {
  evidence: { type: 'string', default: '/Users/michaelchen/Documents/pancake-half-gig/evidence-climb/settings-series' },
  baseline: { type: 'string', default: path.resolve(repository, '../half-gig-baseline') },
  candidate: { type: 'string', default: repository },
  migration: { type: 'string', multiple: true },
} })
const slate = await readJson(path.join(directory, 'training.json'))
const baselines = [], candidates = []
for (const [variant, number] of [['baseline',1],['settings',1],['settings',2],['baseline',2],['baseline',3],['settings',3]]) {
  let quietSince = Date.now()
  console.log('Waiting for sixty quiet seconds before the next measured run.')
  while (Date.now() - quietSince < 60000) {
    if ((await command('docker', ['ps','-q'])).stdout.trim()) quietSince = Date.now()
    await delay(5000)
  }
  const label = `${variant}-${number}`
  let stack
  try {
    stack = await startStack(path.join(values.evidence, label), { sourceRoot: variant === 'baseline' ? values.baseline : values.candidate, migrationOverlays: variant === 'settings' ? values.migration ?? [] : [] })
    stack.qualityEnabled = true
    stack.policyChecks = variant === 'settings'
    stack.qualityOptions = { ...(baselines.length >= 3 ? { limits: actionLimits(baselines) } : {}) }
    stack.runtimeConfiguration = { postgrest: await configurePool(stack, variant === 'settings' ? { connections: 2 } : {}) }
    const report = await runWindow(stack, slate, { label, memoryMiB: 192 })
    await json(path.join(values.evidence, `${label}.json`), report)
    assert.ok(report.passed, `${label} fails a quality gate`)
    assert.equal(report.swap.foreignContainerActivityObserved, false, `${label} overlaps other Docker work`)
    const series = variant === 'baseline' ? baselines : candidates
    series.push(report)
    console.log(`${label} complete; ${baselines.length} baseline and ${candidates.length} settings runs accepted.`)
  } finally { await stack?.stop() }
}
const comparison = compareSeries(baselines, candidates)
assert.ok(comparison.quality, 'Settings regress an action or schedule gate')
await json(path.join(values.evidence, 'baseline-summary.json'), comparison.baseline)
await json(path.join(values.evidence, 'settings-summary.json'), comparison.candidate)
await json(path.join(values.evidence, 'action-limits.json'), comparison.limits)
await json(path.join(values.evidence, 'comparison.json'), { ...comparison, phase: 'settings-only' })
await appendFile('/Users/michaelchen/Documents/pancake-half-gig/ROUND-LOG.md', `\n## Approved settings, paired series\nBaseline: ${comparison.baseline.metrics.swapTotalPagesPerSecond.median} pages/s, n=3. Settings: ${comparison.candidate.metrics.swapTotalPagesPerSecond.median} pages/s, n=3. Noise: ${comparison.noisePagesPerSecond} pages/s. Gain: ${comparison.gainFraction * 100}%. All action and schedule gates pass. This records the approved schedule and a two-connection PostgREST pool before the architecture change.\n`)
console.log(JSON.stringify({ phase: 'settings-only', baseline: comparison.baseline.metrics.swapTotalPagesPerSecond, settings: comparison.candidate.metrics.swapTotalPagesPerSecond, gain: comparison.gainFraction, quality: comparison.quality }))

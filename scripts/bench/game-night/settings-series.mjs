import assert from 'node:assert/strict'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { appendFile } from 'node:fs/promises'
import { directory, json, readJson, repository } from './common.mjs'
import { startStack } from './stack.mjs'
import { configurePool } from './pool.mjs'
import { runWindow } from './experiment.mjs'
import { actionLimits, compareSeries } from './series.mjs'
import { isolatedReplay } from './isolated-series.mjs'

const { values } = parseArgs({ options: {
  evidence: { type: 'string', default: '/Users/michaelchen/Documents/pancake-half-gig/evidence-climb/settings-series' },
  baseline: { type: 'string', default: path.resolve(repository, '../half-gig-baseline') },
  candidate: { type: 'string', default: repository },
  migration: { type: 'string', multiple: true },
  'worker-overlay': { type: 'string', multiple: true },
} })
const slate = await readJson(path.join(directory, 'training.json'))
const baselines = [], candidates = []
let activeStack
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{
  try {await activeStack?.stop()}finally {process.exit(signal==='SIGINT'?130:143)}
})
for (const [variant, number] of [['baseline',1],['settings',1],['settings',2],['baseline',2],['baseline',3],['settings',3]]) {
  const label = `${variant}-${number}`
  const report=await isolatedReplay(async attempt=>{
    let stack
    try {
      stack = activeStack = await startStack(path.join(values.evidence, `${label}-attempt-${attempt}`), { sourceRoot: variant === 'baseline' ? values.baseline : values.candidate, migrationOverlays: variant === 'settings' ? values.migration ?? [] : [],functionOverlays:values['worker-overlay'] ?? [] })
      stack.qualityEnabled = true
      stack.policyChecks = variant === 'settings'
      stack.qualityOptions = { ...(baselines.length >= 3 ? { limits: actionLimits(baselines) } : {}) }
      stack.runtimeConfiguration = { postgrest: await configurePool(stack, variant === 'settings' ? { connections: 2 } : {}) }
      const report = await runWindow(stack, slate, { label, memoryMiB: 192 })
      return report
    } finally {await stack?.stop();activeStack=null}
  })
  await json(path.join(values.evidence,`${label}.json`),report)
  assert.ok(report.passed,`${label} fails its required checks`)
  ;(variant==='baseline'?baselines:candidates).push(report)
  console.log(`${label} complete; ${baselines.length} baseline and ${candidates.length} candidate runs accepted.`)
}
const comparison = compareSeries(baselines, candidates)
assert.ok(comparison.quality, 'Settings regress an action or schedule gate')
await json(path.join(values.evidence, 'baseline-summary.json'), comparison.baseline)
await json(path.join(values.evidence, 'settings-summary.json'), comparison.candidate)
await json(path.join(values.evidence, 'action-limits.json'), comparison.limits)
await json(path.join(values.evidence, 'comparison.json'), { ...comparison, phase: 'settings-only' })
await appendFile('/Users/michaelchen/Documents/pancake-half-gig/ROUND-LOG.md', `\n## Approved settings, paired series\nBaseline: ${comparison.baseline.metrics.cgroupAnonRefaultsPerSecond.median} anon refaults/s, n=3. Baseline quality passed: ${comparison.baselineQualityPassed}; failed reference reports remain failed. Settings: ${comparison.candidate.metrics.cgroupAnonRefaultsPerSecond.median} anon refaults/s, n=3. Noise: ${comparison.noisePagesPerSecond} anon refaults/s. Gain: ${comparison.gainFraction * 100}%. All action and schedule gates pass. This records the approved schedule and a two-connection PostgREST pool before the architecture change.\n`)
console.log(JSON.stringify({ phase: 'settings-only', baseline: comparison.baseline.metrics.cgroupAnonRefaultsPerSecond, settings: comparison.candidate.metrics.cgroupAnonRefaultsPerSecond, gain: comparison.gainFraction, quality: comparison.quality }))

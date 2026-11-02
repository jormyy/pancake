import { parseArgs } from 'node:util'
import assert from 'node:assert/strict'
import path from 'node:path'
import { defaultEvidence, json, repository } from './common.mjs'
import { startStack } from './stack.mjs'
import { configurePool } from './pool.mjs'

const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, evidence: { type: 'string', default: defaultEvidence }, phase: { type: 'string', default: 'run' }, source: { type: 'string', default: repository }, 'worker-overlay': { type: 'string', multiple: true }, label: { type: 'string', default: 'run' }, 'profile-memory': { type: 'boolean', default: false }, pool: { type: 'string' }, 'pool-lifetime': { type: 'string' }, 'pool-idle': { type: 'string' }, quality: { type: 'boolean', default: false }, phones: { type: 'boolean', default: false }, 'public-live': { type: 'boolean', default: false }, policy: { type: 'boolean', default: false }, limits: { type: 'string' }, fault: { type: 'string' }, 'post-tests': { type: 'boolean', default: false }, 'shared-buffers': { type: 'string' }, 'training-result': { type: 'string' }, 'held-out-baseline': { type: 'string' } } })
if (values.help) {
  console.log(`Usage: node scripts/bench/game-night/run.mjs [options]
  --phase run           One training replay at 192 MiB (default)
  --phase held-out      Validate once after a passing training comparison
  --training-result FILE  Passing comparison.json required for held-out
  --held-out-baseline FILE  Three-run cgroup baseline summary for held-out
  --phase controls      Broken-final and ingestion-off controls
  --phase all           Original calibration and baseline workflow, including held-out
  --phase setup|smoke|baseline
  --source PATH         Source checkout for migrations and real workers
  --worker-overlay FILE  Explicit tracked worker correctness fix, with recorded hash
  --evidence PATH       Evidence directory outside the repository
  --label NAME          Single replay report name
  --quality             Run real authenticated actions and score-broadcast gates
  --phones              Run ten subscribed phones against the shared cache
  --public-live         Use public live scores and database checkpoints; implies --phones
  --policy              Check approved injury and forecast schedules during warmup
  --limits PATH         Frozen baseline action latency limits in JSON
  --shared-buffers SIZE  Override and restart the local database before migration
  --pool N              Override the local PostgREST connection pool
  --pool-lifetime N     PostgREST maximum connection lifetime in seconds
  --pool-idle N         PostgREST idle timeout in seconds
  --profile-memory      Probe pooled backend contexts; diagnostic runs only
  --fault NAME          Inject a quality-control failure
  --post-tests          Run focused SQL checks after the timed window
The disposable loopback-only stack always stops. No production data is used.`)
} else {
  const evidence = path.resolve(values.evidence)
  assert.ok(['all','setup','smoke','baseline','run','controls','held-out'].includes(values.phase), 'Choose all, setup, smoke, baseline, run, controls, or held-out')
  assert.ok(path.relative(repository, evidence).startsWith('..'), 'Evidence must stay outside the repository')
  let stack
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => {
    try { await stack?.stop() } finally { process.exit(signal === 'SIGINT' ? 130 : 143) }
  })
  try {
    if (values.phase === 'held-out') {
      const { readJson } = await import('./common.mjs')
      assert.ok(values['training-result'], 'A passing training comparison is required')
      const training = await readJson(values['training-result'])
      assert.ok(training.version === 'game-night-comparison-v3' && training.passed && training.candidate.n >= 3 && training.candidate.metrics.cgroupAnonRefaultsPerSecond.median <= 61, 'The training target must pass before held-out')
    }
    console.log('Starting the disposable local stack.')
    stack = await startStack(evidence, { sourceRoot: path.resolve(values.source), profileMemory: values['profile-memory'], sharedBuffers: values['shared-buffers'],functionOverlays:values['worker-overlay'] ?? [] })
    stack.phoneLab = values.phones || values['public-live']
    stack.liveArchitecture = values['public-live']
    stack.qualityEnabled = values.quality || stack.phoneLab
    stack.policyChecks = values.policy
    stack.qualityOptions = { fault: values.fault }
    if (values.limits) { const { readJson } = await import('./common.mjs'); stack.qualityOptions.limits = await readJson(values.limits) }
    stack.runtimeConfiguration = { postgres: stack.metadata.settings, postgrest: await configurePool(stack, { connections: values.pool == null ? undefined : Number(values.pool), lifetimeSeconds: values['pool-lifetime'] == null ? undefined : Number(values['pool-lifetime']), idleSeconds: values['pool-idle'] == null ? undefined : Number(values['pool-idle']) }) }
    console.log('The real migration and cron catalog are ready.')
    if (values.phase !== 'setup') {
      const { experiment, runWindow } = await import('./experiment.mjs')
      if (['run','controls'].includes(values.phase)) {
        const { readJson, directory } = await import('./common.mjs')
        const slate = await readJson(path.join(directory, 'training.json'))
        if (values.phase === 'run') await runWindow(stack, slate, { label: values.label, memoryMiB: 192 })
        else {
          const broken = await runWindow(stack, slate, { label: 'control-broken-final', memoryMiB: 192, broken: true })
          assert.equal(broken.finalState.passed, false, 'The broken final stat must fail')
          const off = await runWindow(stack, slate, { label: 'control-ingestion-off', memoryMiB: 192, ingestionOff: true, seconds: 120 })
          assert.equal(off.workCounts.passed, false, 'Disabled ingestion must fail the work check')
          assert.equal(off.workCounts.saved,0,'Disabled ingestion must not save live rows')
          assert.ok(off.workCounts.cronRuns>0,'The ingestion-off control must keep background work running')
          if (stack.qualityEnabled) {
            assert.ok(stack.qualityOptions.limits, 'Frozen action limits are required for negative quality controls')
            stack.qualityOptions.fault = 'slow-actions,realtimeScores,forecastDelivery'+(stack.phoneLab?',phone-refresh':'')
            const bad = await runWindow(stack, slate, { label: 'control-quality', memoryMiB: 192 })
            for (const name of ['rosterMove','lineupSave','tradeOffer','tradeAccept','waiverResult','realtimeScores','forecastDelivery']) assert.equal(bad.quality.gates[name].passed, false, `${name} must reject its broken control`)
            if(stack.phoneLab)assert.equal(bad.phones.gates.invalidation.passed,false,'Ignored score broadcasts must fail saved-screen invalidation')
          }
          if(stack.phoneLab) {
            for(const [fault,gate] of [['phone-final','finalScores'],['phone-stale','freshness']]) {
              stack.qualityOptions.fault=fault
              const bad=await runWindow(stack,slate,{label:`control-${fault}`,memoryMiB:192})
              assert.equal(bad.phones.gates[gate].passed,false,`${fault} must fail the phone gate`)
            }
          }
        }
      } else if (values.phase === 'held-out') {
        const { readJson, directory } = await import('./common.mjs')
        assert.ok(values['held-out-baseline'],'A rerun held-out baseline is required')
        const baseline=await readJson(values['held-out-baseline'])
        assert.ok(baseline.n>=3 && baseline.quality.passed,'The held-out baseline must pass')
        const slate = await readJson(path.join(directory, 'held-out.json'))
        const report = await runWindow(stack, slate, { label: 'held-out', memoryMiB: 192 })
        assert.equal(baseline.fixtureSha256,report.fixtureSha256,'The held-out fixtures differ')
        assert.ok(report.passed && report.resources.primary.value <= baseline.metrics.cgroupAnonRefaultsPerSecond.median*.05, 'Held-out does not meet the full bar')
      } else await experiment(stack, values.phase)
      if (values['post-tests']) {
        const results = []
        for (const name of ['io-write-reductions.sql','statistics-maintenance.sql',...(stack.liveArchitecture ? ['live-checkpoints.sql','live-score-view.sql','view-screen-parity.sql'] : [])]) {
          const result = await stack.sqlFile(path.join(repository, 'tests/db', name), { allowFailure: true, output: path.join(evidence, `${name}.log`) })
          results.push({ name, exitCode: result.code })
        }
        await json(path.join(evidence, 'focused-tests.json'), results)
        console.log(JSON.stringify({ focusedTests: results }))
        assert.ok(results.every(result=>result.exitCode===0),'Focused SQL checks must pass')
      }
    }
  } catch (error) {
    await json(path.join(evidence, 'failure.json'), { at: new Date().toISOString(), message: error.message, stack: error.stack })
    console.error(error.message)
    process.exitCode = 1
  } finally { await stack?.stop() }
}

import { parseArgs } from 'node:util'
import assert from 'node:assert/strict'
import path from 'node:path'
import { defaultEvidence, json, repository } from './common.mjs'
import { startStack } from './stack.mjs'

const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, evidence: { type: 'string', default: defaultEvidence }, phase: { type: 'string', default: 'all' } } })
if (values.help) {
  console.log('Usage: node scripts/bench/game-night/run.mjs [--evidence PATH] [--phase all|setup|smoke|baseline]\nBuild a disposable loopback-only Supabase lab. Run calibration, failing controls, three training baselines, and one held-out baseline. Baseline mode reuses recorded calibration and controls. Evidence stays outside the repository. The stack always stops.')
} else {
  const evidence = path.resolve(values.evidence)
  assert.ok(['all','setup','smoke','baseline'].includes(values.phase), 'Choose all, setup, smoke, or baseline')
  assert.ok(path.relative(repository, evidence).startsWith('..'), 'Evidence must stay outside the repository')
  let stack
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => {
    try { await stack?.stop() } finally { process.exit(signal === 'SIGINT' ? 130 : 143) }
  })
  try {
    console.log('Starting the disposable local stack.')
    stack = await startStack(evidence)
    console.log('The real migration and cron catalog are ready.')
    if (values.phase !== 'setup') {
      const { experiment } = await import('./experiment.mjs')
      await experiment(stack, values.phase)
    }
  } catch (error) {
    await json(path.join(evidence, 'failure.json'), { at: new Date().toISOString(), message: error.message, stack: error.stack })
    console.error(error.message)
    process.exitCode = 1
  } finally { await stack?.stop() }
}

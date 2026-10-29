import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { run } from './run.mjs'
import { evidenceFailures, inventory } from './workloads.mjs'
import { accumulatedReceipts, verifyArtifacts } from './report.mjs'
import { evidenceRoot, json } from './common.mjs'

const surfaces = ['trades.analyzer', 'interaction.perf-analyzer-mode.multi-team', 'interaction.perf-analyzer-mode.two-team', 'interaction.perf-analyzer-team.choose', 'interaction.perf-analyzer-team.remove']
const cases = ['interaction.trades-analyzer-offline-light.result/member/in-progress/cold', ...surfaces.flatMap(surface => ['cold', 'warm', 'offline'].map(state => `${surface}/member/in-progress/${state}`))]
for (const name of ['PERF_LAB_SURFACE', 'PERF_LAB_IDENTITY_EXPECTED']) delete process.env[name]
Object.assign(process.env, { PERF_LAB_CAPTURE_PROFILE: 'full', PERF_LAB_CASES: cases.join(','), PERF_LAB_SCOPE: 'all', PERF_LAB_ROLES: 'member', PERF_LAB_DAYS: 'in-progress', PERF_LAB_STATES: 'cold,warm,offline', PERF_LAB_SECONDS: '0', PERF_LAB_STOP_ON_FAILURE: '0' })
await run('walk', undefined, { writeDocs: false })
const root = evidenceRoot
const receipt = JSON.parse(await readFile(path.join(root, 'database-run.json'), 'utf8'))
assert.ok(receipt.cleanup && !receipt.failure, 'Analyzer verification requires a cleanly completed local walk')
const work = await inventory()
const current = JSON.parse(await readFile(path.join(root, 'walk.json'), 'utf8'))
const observations = await accumulatedReceipts(root, current, work.fingerprint)
const results = []
for (const id of cases) {
  const row = work.rows.find(row => row.id === id)
  const observation = observations.find(row => row.id === id)
  const failures = evidenceFailures(row, observation, work.fingerprint)
  if (observation) failures.push(...await verifyArtifacts(observation, root))
  results.push({ id, passed: failures.length === 0, failures })
}
const report = { source: receipt.source, fingerprint: work.fingerprint, passed: results.every(row => row.passed), results }
await json(path.join(root, 'analyzer-verification.json'), report)
console.log(JSON.stringify({ analyzerCases: results.length, passed: results.filter(row => row.passed).length }))
process.exitCode = report.passed ? 0 : 1

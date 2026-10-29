import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { run } from './run.mjs'
import { evidenceFailures, inventory } from './workloads.mjs'
import { accumulatedReceipts, verifyArtifacts } from './report.mjs'
import { evidenceRoot, json } from './common.mjs'

const work = await inventory()
const screens = work.surfaces.filter(surface => !surface.scenario)
const analyzer = ['trades.analyzer', 'interaction.perf-analyzer-mode.multi-team', 'interaction.perf-analyzer-mode.two-team', 'interaction.perf-analyzer-team.choose', 'interaction.perf-analyzer-team.remove']
const cases = [...screens.map(surface => `${surface.id}/commissioner/in-progress/cold`), 'interaction.trades-analyzer-offline-light.result/member/in-progress/cold', ...analyzer.flatMap(surface => ['cold', 'warm', 'offline'].map(state => `${surface}/member/in-progress/${state}`))]
for (const name of ['PERF_LAB_SURFACE', 'PERF_LAB_IDENTITY_EXPECTED']) delete process.env[name]
Object.assign(process.env, { PERF_LAB_CAPTURE_PROFILE: 'full', PERF_LAB_CASES: cases.join(','), PERF_LAB_SCOPE: 'all', PERF_LAB_ROLES: 'commissioner,member', PERF_LAB_DAYS: 'in-progress', PERF_LAB_STATES: 'cold,warm,offline', PERF_LAB_SECONDS: '1200', PERF_LAB_STOP_ON_FAILURE: '0' })
await run('walk', undefined, { writeDocs: false })
const root = evidenceRoot
const receipt = JSON.parse(await readFile(path.join(root, 'database-run.json'), 'utf8'))
assert.ok(receipt.cleanup && !receipt.failure, 'Closure verification requires completed stack cleanup')
const observations = await accumulatedReceipts(root, JSON.parse(await readFile(path.join(root, 'walk.json'), 'utf8')), work.fingerprint)
const results = []
for (const id of cases) {
  const row = work.rows.find(row => row.id === id)
  const observation = observations.find(row => row.id === id)
  const failures = evidenceFailures(row, observation, work.fingerprint)
  if (observation) failures.push(...await verifyArtifacts(observation, root))
  results.push({ id, passed: failures.length === 0, failures })
}
const report = { source: receipt.source, fingerprint: work.fingerprint, screens: screens.length, passed: results.every(row => row.passed), results }
await json(path.join(root, 'closure-verification.json'), report)
console.log(JSON.stringify({ screenAdapters: screens.length, cases: results.length, passed: results.filter(row => row.passed).length, failures: results.filter(row => !row.passed) }))
process.exitCode = report.passed ? 0 : 1

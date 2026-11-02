import { evidencePath } from '../helpers/evidence-path.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { command } from '../../scripts/perf-lab/process.mjs'

Object.assign(process.env, { PERF_LAB_ON_MINI: '1', PERF_LAB_LANE: 'fable-ui27', PERF_LAB_PROJECT: 'pt4bafablesr', PERF_LAB_PORT_PREFIX: '642' })
const { requireMini, localTarget } = await import('../../scripts/perf-lab/common.mjs')
await requireMini()
const status = JSON.parse((await command('supabase', ['status', '-o', 'json'])).stdout)
localTarget(status.API_URL, [64221])
localTarget(status.DB_URL, [64222])
const environment = { ...process.env, SUPABASE_DB_URL: status.DB_URL, PANCAKE_TEST_DB_PORT: '64222' }
const evidence = '../screens-after-211-evidence'
await mkdir(evidence, { recursive: true })
const checks = []
const support = await readFile('tests/db/rules-support.sql', 'utf8')
for (const name of ['screens-after-211', 'slow-screen-addendum', 'view-screen-parity', 'view-player-search-parity', 'trade-curve', 'trade-veto-read-policy', 'trade-offer-pagination', 'offers-do-not-lock', 'pending-asset-locks', 'trade-revaluation-fast', 'trade-revaluation-scope']) {
  const input = (await readFile(`tests/db/${name}.sql`, 'utf8')).replace(/^\\ir rules-support.sql$/m, () => support)
  const result = await command('docker', ['exec', '-i', 'supabase_db_pt4bafablesr', 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input, allowFailure: true, timeout: 240000, label: name })
  await writeFile(`${evidence}/${name}.log`, result.stdout + result.stderr)
  const count = result.stdout.trim().split('\n').filter(line => /^\d+$/.test(line)).at(-1)
  checks.push({ name, passed: result.code === 0, count: count ? Number(count) : null })
  console.log(`${result.code === 0 ? 'PASS' : 'FAIL'} ${name}${count ? `: ${count}` : ''}`)
}
assert.ok(checks.every(row => row.passed))
for (const [name, args] of [
  ['source', ['scripts/check-db-function-sources.mjs', '--check']],
  ['catalog', ['scripts/check-db-function-sources.mjs', '--check-catalog']],
  ['attestations', ['scripts/regenerate-release-history-attestations.mjs']],
]) {
  const result = await command('node', args, { env: environment, timeout: 240000, label: name })
  await writeFile(`${evidence}/${name}.log`, result.stdout + result.stderr)
  checks.push({ name, passed: true })
  console.log(result.stdout.trim())
}
const report = JSON.parse(await readFile(evidencePath('screens-after-211-results.json'), 'utf8'))
assert.ok(report.comparison.every(row => row.passes))
assert.ok(report.installedBuffers.every(row => row.passes))
const result = { migrationSha256: createHash('sha256').update(await readFile('supabase/migrations/20261214003900_screens_after_211.sql')).digest('hex'), checks, samples: Object.values(report.summaries).reduce((sum, rows) => sum + rows.reduce((count, row) => count + row.count, 0), 0), parity: report.parity.reduce((sum, row) => sum + row.count, 0), parityControls: report.parity.length, targets: true }
await writeFile(evidencePath('screens-after-211.json'), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result))

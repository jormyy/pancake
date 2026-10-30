import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const lane = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-l7')
assert.equal(process.cwd(), path.join(lane, 'repo'))
const evidence = path.join(lane, 'evidence')
mkdirSync(evidence, { recursive: true })
const environment = { ...process.env, SUPABASE_DB_URL: 'postgresql://supabase_admin:postgres@127.0.0.1:64822/postgres',
  SUPABASE_URL: 'http://127.0.0.1:64821', PANCAKE_TEST_DB_PORT: '64822', PANCAKE_TEST_API_PORT: '64821',
  PGOPTIONS: '-c statement_timeout=120s -c app.supabase_url=http://127.0.0.1:64821 -c app.edge_internal_token=private-pipeline-night' }
const results = []
for (const [mode, message] of [['control-values', 'Returned values changed'], ['control-rows', 'Touched table row diff changed']]) {
  const result = spawnSync('node', ['--experimental-strip-types', 'tests/db/pipeline-night.mjs', mode, 'live-new', mode], { encoding: 'utf8', env: environment, maxBuffer: 8 * 1024 * 1024 })
  writeFileSync(path.join(evidence, `${mode}.log`), result.stdout + result.stderr)
  const passed = result.status !== 0 && result.stderr.includes(message)
  results.push({ name: mode, passed })
  process.stdout.write(`${mode}: ${passed ? 'PASS (rejected)' : 'FAIL'}\n`)
}
const recipes = ['pipeline-night-context', 'matchup-forecast-history', 'matchup-forecast-cache', 'matchup-forecast-cache-parity',
  'matchup-forecast-season-average', 'forecast-inputs-bound-regression', 'forecast-input-fingerprint', 'forecast-input-write-gate',
  'forecast-queue-write-gate', 'work-queue-forecasts', 'live-fallback-guards', 'live-snapshot-order', 'work-queue-live-poll',
  'live-refresh-shed', 'player-source-connectivity', 'player-source-box', 'player-imports', 'identity-reviewed-alias',
  'identity-first-box', 'identity-nba-trade-locks', 'identity-gap-lock-before-participation', 'work-queue-revaluation-pacing',
  'trade-revaluation-fast', 'trade-revaluation-scope', 'trade-revaluation-coalesce', 'trade-historical-revaluation', 'work-queue-gates', 'live-score-guards']
for (const name of recipes) {
  const source = readFileSync(`tests/db/${name}.sql`, 'utf8').replaceAll('http://127.0.0.1:1', 'http://127.0.0.1:64821')
  const result = spawnSync('psql', [environment.SUPABASE_DB_URL, '-X', '-v', 'ON_ERROR_STOP=1', '-v', 'forecast_api_url=http://127.0.0.1:64821', '-f', '-'],
    { input: source, encoding: 'utf8', env: environment, cwd: path.resolve('tests/db'), maxBuffer: 16 * 1024 * 1024 })
  writeFileSync(path.join(evidence, `${name}.log`), result.stdout + result.stderr)
  results.push({ name, passed: result.status === 0, status: result.status })
  process.stdout.write(`${name}: ${result.status === 0 ? 'PASS' : `FAIL ${result.stderr.slice(-700)}`}\n`)
}
const denoFiles = ['dispatcher', 'live-poll', 'matchup-forecast', 'sync-players', 'sync-rankings'].flatMap(directory =>
  readdirSync(`supabase/functions/${directory}`).filter(file => file.endsWith('.test.ts')).map(file => `supabase/functions/${directory}/${file}`))
const deno = spawnSync('deno', ['test', '--cached-only', '--allow-env', '--allow-read', '--allow-net=127.0.0.1', ...denoFiles],
  { encoding: 'utf8', env: environment, maxBuffer: 16 * 1024 * 1024 })
writeFileSync(path.join(evidence, 'deno.log'), deno.stdout + deno.stderr)
results.push({ name: 'deno', passed: deno.status === 0, status: deno.status, summary: deno.stdout.replaceAll(/\x1b\[[0-9;]*m/g, '').split('\n').filter(line => /passed.*failed/.test(line)).slice(-1) })
process.stdout.write(`Deno: ${deno.status === 0 ? 'PASS' : `FAIL ${deno.stderr.slice(-1500)}`}\n`)
writeFileSync(path.join(evidence, 'verification.json'), JSON.stringify(results, null, 2))
assert.ok(results.every(row => row.passed), 'Pipeline verification failed')

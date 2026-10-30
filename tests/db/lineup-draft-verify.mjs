import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const lane = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-a3')
assert.equal(process.cwd(), path.join(lane, 'repo'))
const recipes = ['autoset-keep-starters', 'historical-lineup-lock', 'lineup-departed-lock',
  'lineup-optimizer-idempotence', 'zero-lineup-slots', 'idempotency-lineup', 'draft-goal-behavior',
  'draft-timer-behavior', 'draft-timer-range', 'draft-timer-pause', 'draft-timer-legacy',
  'draft-timer-mock', 'linear-draft-order', 'idempotency-draft', 'draft-reset-season',
  'draft-reset-trade-queue', 'draft-board-experience-fence', 'taxi-autopick', 'taxi-auction-pool',
  'lineup-draft-version', 'notif-draft-transitions', 'notification-lineup-gate']
const directory = path.join(lane, 'evidence')
mkdirSync(directory, { recursive: true })
const results = []
const database = 'postgresql://postgres:postgres@127.0.0.1:64522/postgres'
const environment = { ...process.env, SUPABASE_DB_URL: database, PANCAKE_TEST_DB_PORT: '64522' }
for (const recipe of recipes) {
  const prefix = recipe === 'draft-timer-behavior' ? "BEGIN; SELECT cron.alter_job(cron.schedule('work-dispatcher','* * * * *','SELECT 1'),active:=false);\n" : ''
  const result = spawnSync('psql', [database, '-X', '-v', 'ON_ERROR_STOP=1'], { input: `${prefix}\\ir ${path.resolve(`tests/db/${recipe}.sql`)}\n`, encoding: 'utf8', env: environment, maxBuffer: 16 * 1024 * 1024, timeout: 120000 })
  writeFileSync(path.join(directory, `${recipe}.log`), result.stdout + result.stderr)
  results.push({ recipe, passed: result.status === 0 })
  process.stdout.write(`${result.status === 0 ? 'PASS' : 'FAIL'} ${recipe}\n`)
}
writeFileSync(path.join(directory, 'sql-tests.json'), JSON.stringify(results, null, 2))
assert.ok(results.every(result => result.passed), `Failed: ${results.filter(result => !result.passed).map(result => result.recipe).join(', ')}`)

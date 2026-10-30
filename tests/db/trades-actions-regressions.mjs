import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

assert.equal(process.cwd(), path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-a1/repo'))
const files = ['trade-structured-legality', 'trade-legality-drops', 'trade-roster-plans', 'trade-plan-moves-capacity',
  'trade-incoming-destinations', 'trade-retained-taxi-rejection', 'server-trade-plan-acceptance', 'release2-trade-accept-capacity',
  'trade-offer-counterparty', 'trade-offer-retries', 'trade-identical-offers', 'trade-expiry-authorization', 'rules-trade-submit-plans',
  'rules-trade-reservation-message', 'trade-locks-drop-only', 'trade-estimate-snapshots', 'trade-estimate-work',
  'trade-pick-labels', 'trade-values', 'trade-curve', 'idempotency-trades', 'taxi-trade-game-lock-deferral',
  'rules-trade-rejection-notifications', 'history-lock-trade-settlement', 'trade-veto-read-policy']
const results = []
for (const file of files) {
  try {
    const output = execFileSync('psql', ['postgresql://postgres:postgres@127.0.0.1:64322/postgres', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-f', `tests/db/${file}.sql`],
      { encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
    results.push({ file, passed: true, output: output.trim().slice(-200) })
  } catch (error) {
    results.push({ file, passed: false, error: String(error.stderr).slice(-2000) })
  }
  console.log(JSON.stringify(results.at(-1)))
}
writeFileSync('../evidence/sql-regressions.json', `${JSON.stringify(results, null, 2)}\n`)
assert.ok(results.every(result => result.passed), 'Every selected trade regression must pass')

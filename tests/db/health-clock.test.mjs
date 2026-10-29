import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { connectionEnvironment } from '../../scripts/db-health/index.mjs'

test('transaction ages use server time during a replay', { skip: !process.env.SUPABASE_DB_URL, timeout: 15000 }, async () => {
  const env = connectionEnvironment(process.env.SUPABASE_DB_URL)
  const holder = spawn('psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1'], { env })
  holder.stderr.resume()
  const exited = once(holder, 'exit')
  const lines = createInterface({ input: holder.stdout })
  holder.stdin.write("BEGIN;\nSELECT 'health-clock-ready';\n")
  try {
    let ready = false
    for await (const line of lines) {
      if (line === 'health-clock-ready') { ready = true; break }
    }
    assert.ok(ready, 'The test transaction must be open')
    const source = readFileSync(new URL('../../scripts/db-health/snapshot.sql', import.meta.url), 'utf8')
    const sql = source.replace(/COMMIT;\s*$/, `SELECT coalesce(json_agg(xact_start),'[]') FROM pg_stat_activity
WHERE datname=current_database() AND pid<>pg_backend_pid() AND xact_start IS NOT NULL;
COMMIT;`)
    const before = Date.now()
    const output = execFileSync('psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024 })
    const after = Date.now()
    const [report, starts] = output.trim().split('\n').map(line => JSON.parse(line))
    assert.ok(starts.length > 0, 'The report must observe an open transaction')
    const oldest = Math.min(...starts.map(value => Date.parse(value)))
    const minimum = (before - oldest) / 1000
    const maximum = (after - oldest) / 1000
    assert.ok(report.oldestTransactionSeconds >= minimum - 2 && report.oldestTransactionSeconds <= maximum + 2,
      `Transaction age ${report.oldestTransactionSeconds} is outside the host-time range ${minimum} to ${maximum}`)
  } finally {
    holder.stdin.end('ROLLBACK;\n\\q\n')
    assert.equal((await exited)[0], 0)
  }
})

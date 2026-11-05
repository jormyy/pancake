import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const db = new URL(process.env.SUPABASE_DB_URL)
const port = process.env.PANCAKE_TEST_DB_PORT ?? '54322'
assert.ok(['127.0.0.1', 'localhost'].includes(db.hostname) && db.port === port)
db.username = 'supabase_admin'
const run = args => {
  const result = spawnSync('psql', [db.href, '-XqAtv', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8', timeout: 60000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const jobsQuery = "SELECT COALESCE(jsonb_agg(to_jsonb(job) ORDER BY jobid), '[]'::jsonb) FROM cron.job job"
const jobs = run(['-c', jobsQuery])
let installed = false
try {
  for (const [at, day] of [
    ['2026-11-01T04:30:00Z', '2026-11-01'],
    ['2026-11-01T06:30:00Z', '2026-11-01'],
    ['2026-11-02T04:59:59Z', '2026-11-01'],
    ['2026-11-02T05:00:00Z', '2026-11-02'],
  ]) {
    run(['-v', `season_sim_port=${port}`, '-v', `sim_ms=${Date.parse(at)}`, '-v', `real_ms=${Date.now()}`,
      '-v', 'rate=0', '-v', `cap_ms=${Date.parse(at)}`, '-f', 'scripts/season-sim/clock.sql'])
    installed = true
    for (const days of [7, 15]) {
      const window = JSON.parse(run(['-c', `SELECT public.stats_window(${days})`]))
      assert.equal(window.endDate, day)
      const start = new Date(`${day}T00:00:00Z`)
      start.setUTCDate(start.getUTCDate() - days + 1)
      assert.equal(window.startDate, start.toISOString().slice(0, 10))
      assert.equal(window.timeZone, 'America/New_York')
    }
    const output = run(['-f', 'tests/db/player-stats-windows.sql'])
    assert.match(output, /selected window sorts the entire pool before pagination/)
    console.log(`PASS ${at}: Eastern date ${day}; both windows, partial day, boundaries, nulls, scoring and pagination`)
  }
} finally {
  try {
    if (installed) run(['-v', `season_sim_port=${port}`, '-f', 'scripts/season-sim/restore-clock.sql'])
  } finally {
    run(['-c', `BEGIN; DELETE FROM cron.job; INSERT INTO cron.job SELECT * FROM jsonb_populate_recordset(NULL::cron.job, '${jobs.replaceAll("'", "''")}'); COMMIT;`])
    assert.equal(run(['-c', jobsQuery]), jobs, 'The clock test preserves the scheduled job catalog')
  }
}

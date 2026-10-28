import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { 'matchup-id': { type: 'string', multiple: true } } })
const matchupIds = values['matchup-id'] ?? []
assert.ok(matchupIds.length > 0, 'Supply --matchup-id for each restored matchup')
const target = new URL(process.env.SUPABASE_DB_URL)
assert.equal(target.hostname, '127.0.0.1')
assert.equal(target.port, process.env.PANCAKE_TEST_DB_PORT)
assert.ok(['postgres:', 'postgresql:'].includes(target.protocol) && !target.search && !target.hash)
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')))
Object.assign(env, {
  PGHOST: target.hostname, PGPORT: target.port, PGDATABASE: target.pathname.slice(1),
  PGUSER: decodeURIComponent(target.username), PGPASSWORD: decodeURIComponent(target.password),
  PGPASSFILE: '/dev/null', PGSSLMODE: 'disable',
})
const query = sql => JSON.parse(execFileSync('psql', ['-XqAtv', 'ON_ERROR_STOP=1', '-c',
  `SET statement_timeout=5000; SET plan_cache_mode=force_generic_plan; ${sql}`], { env, encoding: 'utf8', timeout: 10000 }))

for (const id of matchupIds) {
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  const prepareStarted = performance.now()
  const dates = query(`SELECT public.prepare_matchup_forecast_inputs('${id}')`)
  for (const date of dates) {
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/)
    query(`SELECT public.prepare_matchup_forecast_inputs('${id}','${date}')`)
  }
  const prepareElapsedMs = performance.now() - prepareStarted
  const context = query(`SELECT public.get_prepared_matchup_forecast_context('${id}')`)
  assert.ok(context?.roster.length >= 40, 'Use a populated matchup with two production-sized rosters')
  assert.ok(context.games.length > 0, 'Use a matchup with remaining NBA games')
  assert.ok(context.history.length >= 20, 'Use players with production-sized game histories')
  assert.ok(context.history.every(player => player.scores.length > 0 && player.scores.length <= 30))
  const samples = []
  for (let sample = 0; sample < 3; sample++) {
    const [plan] = query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT public.get_prepared_matchup_forecast_context('${id}')`)
    const buffers = plan.Plan['Shared Hit Blocks'] + plan.Plan['Shared Read Blocks']
    samples.push({ elapsedMs: plan['Planning Time'] + plan['Execution Time'], buffers })
  }
  console.log(JSON.stringify({ matchupId: id, roster: context.roster.length, prepareElapsedMs, samples }))
  assert.ok(samples.every(sample => sample.elapsedMs < 300), 'Prepared forecast reads must finish within 300 ms')
  assert.ok(samples.every(sample => sample.buffers < 5000 + context.roster.length * 30), 'Forecast reads must use prepared history and projection inputs')
}

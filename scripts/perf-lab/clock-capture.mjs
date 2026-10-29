import assert from 'node:assert/strict'
import path from 'node:path'
import { sql } from '../season-sim/local-stack.mjs'
import { json, requireMini } from './common.mjs'

const functions = ['pg_catalog.now()', 'pg_catalog.clock_timestamp()', 'pg_catalog.transaction_timestamp()', 'pg_catalog.statement_timestamp()', 'season_sim.time(timestamp with time zone)']
const targets = functions.map(name => `'${name}'::regprocedure`).join(',')
const stateSql = `SELECT json_build_object(
  'clock',now(),'rate',(SELECT rate FROM season_sim.clock WHERE singleton),
  'plans',current_setting('auto_explain.log_min_duration'),
  'statements',current_setting('pg_stat_statements.track'),
  'virtualFunctions',(SELECT count(*) FROM pg_proc WHERE oid=ANY(ARRAY[${targets}])
    AND (prosrc LIKE '%season_sim.time%' OR prosrc LIKE '%season_sim.clock%')),
  'suppressedFunctions',(SELECT count(*) FROM pg_proc WHERE oid=ANY(ARRAY[${targets}])
    AND proconfig @> ARRAY['auto_explain.log_min_duration=-1']));`

export async function configureClockCapture(evidence, execute = sql, verify = requireMini) {
  await verify()
  const before = JSON.parse(await execute(stateSql))
  assert.equal(before.virtualFunctions, functions.length, 'Only installed virtual-clock functions can omit nested plans')
  assert.equal(before.rate, 0, 'Clock capture requires paused business time')
  assert.ok(Number.parseFloat(before.plans) >= 0, 'Full capture must retain sampled product query plans')
  assert.equal(before.statements, 'all', 'Full capture must retain every statement statistic')
  await execute(functions.map(name => `ALTER FUNCTION ${name} SET auto_explain.log_min_duration = '-1';`).join('\n'))
  const after = JSON.parse(await execute(stateSql))
  assert.equal(after.clock, before.clock, 'Capture configuration must preserve business time')
  assert.equal(after.suppressedFunctions, functions.length)
  assert.equal(after.plans, before.plans)
  assert.equal(after.statements, before.statements)
  const receipt = { before, after, excludedNestedPlans: functions, productQueryPlans: 'sampled slow statements', statementStatistics: 'all' }
  await json(path.join(evidence, 'clock-capture.json'), receipt)
  return receipt
}

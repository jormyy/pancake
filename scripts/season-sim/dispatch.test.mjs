import assert from 'node:assert/strict'
import test from 'node:test'
import { dispatch } from './dispatch.mjs'

test('deferred minute gates retain their commands in one database round trip', async () => {
  const queries = []
  const statement = 'SELECT public.invoke_live_poll_if_due(); SELECT public.invoke_process_trades_if_due()'
  const rows = await dispatch(statement, { defer: true }, async query => { queries.push(query); return '[17,18]' })
  assert.equal(queries.length, 1)
  assert.ok(queries[0].includes(statement.replace(/(^|;)\s*SELECT\b/gi, '$1 PERFORM')))
  assert.match(queries[0], /WHERE id>before_id/)
  assert.deepEqual(rows.map(row => row.id), [17, 18])
  await assert.rejects(dispatch('SELECT 1', { defer: true }, async () => '[]'), /no invocation/)
})

test('production-only dispatch still rejects a manual scorer before executing SQL', async () => {
  const previous = process.env.SEASON_SIM_PRODUCTION_ONLY
  process.env.SEASON_SIM_PRODUCTION_ONLY = '1'
  try {
    await assert.rejects(dispatch("SELECT public.invoke_edge_function('sync-scores')", { defer: true }, async () => { throw new Error('SQL must not execute') }), /forbids direct/)
  } finally {
    if (previous == null) delete process.env.SEASON_SIM_PRODUCTION_ONLY
    else process.env.SEASON_SIM_PRODUCTION_ONLY = previous
  }
})

test('production-only dispatch rejects direct injury refreshes before executing SQL', async () => {
  const previous = process.env.SEASON_SIM_PRODUCTION_ONLY
  process.env.SEASON_SIM_PRODUCTION_ONLY = '1'
  try {
    await assert.rejects(dispatch("SELECT public.invoke_edge_function('sync-player-injuries')", { defer: true }, async () => { throw new Error('SQL must not execute') }), /forbids direct/)
  } finally {
    if (previous == null) delete process.env.SEASON_SIM_PRODUCTION_ONLY
    else process.env.SEASON_SIM_PRODUCTION_ONLY = previous
  }
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { maintenanceTick, waitForRollover } from './maintenance.mjs'

test('daily maintenance expires waivers before the season boundary through production dispatchers', async () => {
  const calls = []
  await maintenanceTick(async statement => { calls.push(statement); return [] }, async statement => { calls.push(statement); return '' })
  assert.deepEqual(calls, [
    'SELECT private.reconcile_edge_invocations()',
    "SELECT public.invoke_edge_function_at_et_time('process-waivers',3,0)",
    'SELECT public.invoke_season_boundary_if_due()',
  ])
})

test('a retained failed boundary recovers on the second quarter-hour tick without rewinding', async () => {
  const start = Date.parse('2026-04-15T14:00:00Z')
  const moves = []
  let current = 'old', ticks = 0
  const result = await waitForRollover({
    start, deadline: start + 30 * 60000, oldSeason: 'old',
    move: async at => { moves.push(at) },
    tick: async () => { if (++ticks === 2) current = 'new'; return [] },
    current: async () => current,
  })
  assert.equal(result.season, 'new')
  assert.deepEqual(moves, ['2026-04-15T14:15:00.000Z', '2026-04-15T14:30:00.000Z'])
  assert.equal(result.ticks, 2)
})

test('a blocked boundary is never accepted merely because its HTTP response is 200', async () => {
  const failed = { status_code: 200, worker_status: 'failed', content: JSON.stringify({ leagues: [{ error: 'Resolve pending waiver claims and waiver holds before advancing season.' }] }) }
  assert.equal((await maintenanceTick(async statement => statement.includes('season_boundary') ? [failed] : [], async () => '')).length, 1)
  await assert.rejects(waitForRollover({ start: 0, deadline: 30 * 60000, oldSeason: 'old', move: async () => {}, tick: async () => [failed], current: async () => 'old' }), /did not roll over.*2 ticks/)
  await assert.rejects(maintenanceTick(async () => [{ ...failed, content: '{"leagues":[{"error":"unrelated backend failure"}]}' }], async () => ''), /unexpected maintenance failure/)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { maintenanceTick, rolloverDeadline, waiverBoundaryDeferral, waitForRollover } from './maintenance.mjs'

test('daily maintenance expires waivers before the season boundary through production dispatchers', async () => {
  const calls = []
  await maintenanceTick(async statement => { calls.push(statement); return [] }, async statement => { calls.push(statement); return '' })
  assert.deepEqual(calls, [
    'SELECT public.dispatch_work()',
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
  assert.equal((await maintenanceTick(async statement => statement.includes('dispatch_work') ? [failed] : [], async () => '')).length, 1)
  await assert.rejects(waitForRollover({ start: 0, deadline: 30 * 60000, oldSeason: 'old', move: async () => {}, tick: async () => [failed], current: async () => 'old' }), /did not roll over.*2 ticks/)
  await assert.rejects(maintenanceTick(async () => [{ ...failed, content: '{"leagues":[{"error":"unrelated backend failure"}]}' }], async () => ''), /unexpected maintenance failure/)
})

const settledWaivers = { name: 'postseason-pending', checked: true, processAt: Date.parse('2026-04-15T07:00:00Z'), input: { claims: [{ id: 'winner', drop: 'old-player' }] }, expected: { claims: { winner: 'succeeded' } }, targets: [{ clearsAt: Date.parse('2026-04-14T14:00:00Z') }] }

test('successful conditional drops extend the rollover bound through their own waiver holds', () => {
  const start = Date.parse('2026-04-13T14:06:00Z'), ready = Date.parse('2026-04-15T04:08:00Z')
  assert.equal(rolloverDeadline(start, ready, [settledWaivers]), Date.parse('2026-04-19T09:00:00Z'))
  assert.equal(rolloverDeadline(start, ready, []), ready + 26 * 3600000)
})

test('a processed postseason batch can still block the boundary with new conditional-drop holds', () => {
  const context = { leagueId: 'league', waiverScenarios: [settledWaivers] }
  const outcome = { function_name: 'season-boundary', worker_status: 'failed', status_code: 200, content: JSON.stringify({ leagues: [{ leagueId: 'league', error: 'Resolve pending waiver claims and waiver holds before advancing season.' }] }) }
  assert.equal(waiverBoundaryDeferral(outcome, context, Date.parse('2026-04-15T13:00:00Z')), true)
  assert.equal(waiverBoundaryDeferral(outcome, context, Date.parse('2026-04-19T13:00:00Z')), false)
  assert.equal(waiverBoundaryDeferral({ ...outcome, content: '{"leagues":[{"leagueId":"other","error":"Resolve pending waiver claims and waiver holds before advancing season."}]}' }, context, Date.parse('2026-04-15T13:00:00Z')), false)
})

test('an unclaimed conditional-drop hold expires on the first daily run strictly after its clear time', () => {
  const context = { leagueId: 'league', waiverScenarios: [settledWaivers] }
  const outcome = { function_name: 'season-boundary', worker_status: 'failed', status_code: 200, content: JSON.stringify({ leagues: [{ leagueId: 'league', error: 'Resolve pending waiver claims and waiver holds before advancing season.' }] }) }
  assert.equal(waiverBoundaryDeferral(outcome, context, Date.parse('2026-04-18T13:00:00Z')), true)
})

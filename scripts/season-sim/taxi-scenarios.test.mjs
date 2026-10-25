import assert from 'node:assert/strict'
import test from 'node:test'
import * as invariants from './invariants.mjs'

const context = response => ({
  leagueId: 'league', leagueSeasonId: 'season', users: [{ memberId: 'owner' }],
  rpc: async (user, name, body, expected) => {
    assert.equal(user.memberId, 'owner')
    assert.equal(name, 'add_free_agent_atomic')
    assert.deepEqual(body, { p_member_id: 'owner', p_league_id: 'league', p_player_id: 'free' })
    assert.equal(expected, 400)
    return response
  },
})
const illegal = [{ member_id: 'owner', player_name: 'Veteran', candidate: 'free' }]

test('daily taxi invariant accepts legal teams without attempting a transaction', async () => {
  const c = { ...context(null), rpc: async () => assert.fail('Legal teams need no refusal probe') }
  assert.deepEqual(await invariants.assertTaxiTransactions(c, async () => '[]'), { eligible: true, blockedTeams: 0 })
})

test('daily taxi invariant accepts an ineligible player only when its owner is refused with PA009 and the player name', async () => {
  const result = await invariants.assertTaxiTransactions(context({ code: 'PA009', message: 'Activate or drop Veteran.' }), async () => JSON.stringify(illegal))
  assert.deepEqual(result, { eligible: false, blockedTeams: 1 })
})

test('daily taxi invariant rejects admitted transactions, the IR error code, and unnamed roster problems', async () => {
  for (const response of [{ id: 'added' }, { code: 'PA005', message: 'Veteran' }, { code: 'PA009', message: 'Invalid roster' }]) {
    await assert.rejects(invariants.assertTaxiTransactions(context(response), async () => JSON.stringify(illegal)))
  }
})

test('daily taxi invariant checks every affected owner and names each affected player', async () => {
  const rows = [...illegal, { ...illegal[0], player_name: 'Second Veteran' }, { member_id: 'other', player_name: 'Unknown games', candidate: 'free' }]
  const calls = []
  const c = {
    ...context(null), users: [{ memberId: 'owner' }, { memberId: 'other' }],
    rpc: async user => {
      calls.push(user.memberId)
      return { code: 'PA009', message: rows.filter(row => row.member_id === user.memberId).map(row => row.player_name).join(', ') }
    },
  }
  assert.deepEqual(await invariants.assertTaxiTransactions(c, async () => JSON.stringify(rows)), { eligible: false, blockedTeams: 2 })
  assert.deepEqual(calls, ['owner', 'other'])
})

const acquisitions = async () => {
  const { beginTaxiAcquisitions, verifyTaxiAcquisitions } = await import('./taxi-scenarios.mjs')
  const users = ['adding', 'claiming'].map(memberId => ({ memberId }))
  const now = Date.parse('2026-01-08T08:00:00Z')
  const hold = { clears_at: new Date(now).toISOString() }
  const rows = new Map(), calls = []
  let claim
  const c = {
    leagueId: 'league', leagueSeasonId: 'season', users,
    expectedWaiverPriorities: { adding: 1, claiming: 2 },
    rpc: async (user, name, body) => {
      calls.push({ user: user.memberId, name, body })
      if (name === 'add_free_agent_atomic') rows.set(user.memberId, { id: 'added', is_on_ir: body.p_to_ir, is_on_taxi: body.p_to_taxi })
      if (name === 'drop_player_atomic') rows.delete(user.memberId)
    },
    api: async (user, route, body) => {
      assert.equal(route, '/waivers/claims')
      claim = { id: 'claim', to_taxi: body.toTaxi, status: 'pending' }
    },
    rest: async (user, query) => query.startsWith('waiver_wire_log') ? [hold] : query.startsWith('waiver_claims') ? [claim] : [rows.get(user.memberId)].filter(Boolean),
  }
  const execute = async statement => statement.startsWith('SELECT p.id') ? 'player' : statement.includes('current_add_week_number') ? '2' : String(now)
  return { beginTaxiAcquisitions, verifyTaxiAcquisitions, c, rows, calls, execute, now, settle: () => {
    claim.status = 'succeeded'
    claim.processed_at = new Date(now).toISOString()
    rows.set('claiming', { id: 'claimed', is_on_taxi: claim.to_taxi, is_on_ir: false })
  } }
}

test('week-two scenario adds into taxi and claims the dropped player into another full team taxi', async () => {
  const f = await acquisitions(), report = {}
  await f.beginTaxiAcquisitions(f.c, report, f.execute)
  assert.equal(report.taxiAcquisition.passed, false)
  assert.deepEqual(f.c.expectedAddsByWeek['season:2'], { adding: 1, claiming: 0 })
  assert.equal(f.rows.size, 0)
  f.settle()
  await f.verifyTaxiAcquisitions(f.c, report, f.execute)
  assert.equal(report.taxiAcquisition.passed, true)
  assert.deepEqual(f.c.expectedAddsByWeek['season:2'], { adding: 1, claiming: 1 })
  assert.deepEqual(f.c.expectedWaiverPriorities, { adding: 1, claiming: 3 })
  assert.equal(f.rows.size, 0)
  const count = f.calls.length
  await f.beginTaxiAcquisitions(f.c, report, f.execute)
  await f.verifyTaxiAcquisitions(f.c, report, f.execute)
  assert.equal(f.calls.length, count)
})

test('the taxi scenario rejects an add that lands on the active roster', async () => {
  const f = await acquisitions()
  const rpc = f.c.rpc
  f.c.rpc = async (user, name, body) => rpc(user, name, { ...body, p_to_taxi: false })
  await assert.rejects(f.beginTaxiAcquisitions(f.c, {}, f.execute), /full active roster/)
})

test('the taxi scenario rejects a claim that loses its destination or lands active', async () => {
  const f = await acquisitions(), report = {}
  await f.beginTaxiAcquisitions(f.c, report, f.execute)
  f.settle()
  f.rows.set('claiming', { id: 'claimed', is_on_taxi: false, is_on_ir: false })
  await assert.rejects(f.verifyTaxiAcquisitions(f.c, report, f.execute), /enters taxi/)
  assert.equal(report.taxiAcquisition.passed, false)
})

test('daily taxi invariant accepts a higher priority IR or overflow refusal only when that problem also exists', async () => {
  const ir = illegal.map(row => ({ ...row, ir_names: ['Recovered Player'] }))
  assert.equal((await invariants.assertTaxiTransactions(context({ code: 'PA005', message: 'Activate Recovered Player.' }), async () => JSON.stringify(ir))).blockedTeams, 1)
  const overflow = illegal.map(row => ({ ...row, active_overflow: true }))
  assert.equal((await invariants.assertTaxiTransactions(context({ code: 'PA003', message: 'Your active roster exceeds the limit.' }), async () => JSON.stringify(overflow))).blockedTeams, 1)
  await assert.rejects(invariants.assertTaxiTransactions(context({ code: 'PA003', message: 'Your active roster is full.' }), async () => JSON.stringify(illegal)))
})

test('a resumed taxi scenario retains its evidence without repeating acquisitions', async () => {
  const f = await acquisitions(), report = {}
  await f.beginTaxiAcquisitions(f.c, report, f.execute)
  f.settle()
  await f.verifyTaxiAcquisitions(f.c, report, f.execute)
  const restored = {}, calls = f.calls.length
  await f.verifyTaxiAcquisitions(f.c, restored, f.execute)
  assert.equal(restored.taxiAcquisition.passed, true)
  assert.equal(restored.taxiAcquisition.claimId, 'claim')
  assert.equal(f.calls.length, calls)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { waiverResetAt, checkWaiverReset, waiverParticipants, waiverOutcomes, checkWaiverResult, checkWaiverTiming, rolloverPriorities } from './waiver-oracle.mjs'

const input = { mode: 'faab', priorities: { a: 1, b: 2, c: 3 }, budgets: { a: 100, b: 20, c: 100 }, rosterCounts: { a: 3, b: 3, c: 3 }, weeklyCounts: { a: 0, b: 0, c: 0 }, limit: 1, rosterSize: 3,
  claims: [
    { id: 'full', player: 'p', member: 'a', bid: 90, order: 1, submitted: 'now' },
    { id: 'poor', player: 'p', member: 'b', bid: 30, drop: 'b1', order: 1, submitted: 'now' },
    { id: 'winner', player: 'p', member: 'c', bid: 20, drop: 'c1', order: 1, submitted: 'now' },
    { id: 'limited', player: 'q', member: 'c', bid: 10, drop: 'c2', order: 2, submitted: 'now' },
    { id: 'tie-a', player: 'r', member: 'a', bid: 5, drop: 'a1', order: 2, submitted: 'now' },
    { id: 'tie-b', player: 'r', member: 'b', bid: 5, drop: 'b2', order: 2, submitted: 'now' },
  ] }

test('FAAB resolves price, current priority, budget, roster room and the add limit independently', () => {
  const expected = waiverOutcomes(input)
  assert.deepEqual(expected.claims, { full: 'failed_roster', poor: 'failed_priority', winner: 'succeeded', limited: 'failed_roster', 'tie-a': 'succeeded', 'tie-b': 'failed_priority' })
  assert.deepEqual(expected.budgets, { a: 95, b: 20, c: 80 })
  assert.deepEqual(expected.priorities, { a: 5, b: 2, c: 4 })
  const observed = { claims: Object.entries(expected.claims).map(([id, status]) => ({ id, status })), priorities: Object.entries(expected.priorities).map(([member_id, priority]) => ({ member_id, priority })), states: Object.fromEntries(Object.keys(expected.priorities).map(member => [member, { faab_balance: expected.budgets[member], weekly_add_count: expected.weeklyCounts[member] }])), rosterCounts: expected.rosterCounts }
  assert.ok(checkWaiverResult(expected, observed).passed)
  const corruptions = [
    data => { data.claims[0].status = 'succeeded' },
    data => { data.priorities[0].priority++ },
    data => { data.states.a.faab_balance++ },
    data => { data.states.a.weekly_add_count++ },
    data => { data.rosterCounts.a++ },
  ]
  for (const corrupt of corruptions) {
    const data = structuredClone(observed)
    corrupt(data)
    assert.throws(() => checkWaiverResult(expected, data), /Waiver|FAAB|Weekly/)
  }
})
test('rolling ignores bid amounts and rollover uses reverse standings with documented secondary ties', () => {
  const expected = waiverOutcomes({ ...input, mode: 'rolling', claims: input.claims.filter(row => ['winner', 'tie-a', 'tie-b'].includes(row.id)) })
  assert.equal(expected.claims['tie-a'], 'succeeded')
  assert.deepEqual(expected.budgets, input.budgets)
  assert.deepEqual(rolloverPriorities(['a', 'b', 'c'], [{ member_id: 'a', wins: 1, points_for: 10, losses: 2, points_against: 30, week_number: 22 }, { member_id: 'b', wins: 1, points_for: 10, losses: 3, points_against: 20, week_number: 22 }]), { c: 1, b: 2, a: 3 })
})

test('waiver processing remains at 03:00 Eastern across the DST change', async () => {
  const { nextWaiverRun } = await import('./waiver-scenarios.mjs')
  assert.equal(new Date(nextWaiverRun(Date.parse('2026-10-31T14:00:00Z'))).toISOString(), '2026-11-01T08:00:00.000Z')
  assert.equal(new Date(nextWaiverRun(Date.parse('2026-10-30T14:00:00Z'))).toISOString(), '2026-10-31T07:00:00.000Z')
})

test('waiver timing rejects both early and late observed processing', () => {
  const expected = Date.parse('2026-03-19T07:00:00Z')
  assert.ok(checkWaiverTiming('2026-03-19T07:00:00Z', expected))
  for (const observed of ['2026-03-19T06:59:00Z', '2026-03-19T07:15:00Z']) assert.throws(() => checkWaiverTiming(observed, expected), /03:00 Eastern/)
})

test('later waiver batches select an actually full claimant after earlier donor drops', () => {
  const users = ['a', 'b', 'c', 'd'].map(memberId => ({ memberId }))
  const priorities = { a: 6, b: 5, c: 3, d: 4 }
  const rosters = { a: [1, 2, 3], b: [1, 2, 3], c: [1, 2], d: [1, 2] }
  assert.deepEqual(waiverParticipants(users, priorities, rosters, 3).map(row => row.memberId), ['b', 'c', 'd', 'a'])
  assert.throws(() => waiverParticipants(users, priorities, { ...rosters, a: [], b: [] }, 3), /actual full roster/)
})

test('eligible-week add resets stay at Eastern midnight through the November DST change', () => {
  assert.equal(new Date(waiverResetAt('2026-10-25')).toISOString(), '2026-10-26T04:00:00.000Z')
  assert.equal(new Date(waiverResetAt('2026-11-01')).toISOString(), '2026-11-02T05:00:00.000Z')
  const state = { week_number: 2, weekly_add_count: 0, add_limit_resets_at: '2026-11-02T05:00:00Z' }
  checkWaiverReset(state, 2, waiverResetAt('2026-11-01'))
  assert.throws(() => checkWaiverReset({ ...state, add_limit_resets_at: '2026-11-02T04:00:00Z' }, 2, waiverResetAt('2026-11-01')), /DST/)
  assert.throws(() => checkWaiverReset({ ...state, weekly_add_count: 1 }, 2, waiverResetAt('2026-11-01')), /fresh add/)
  assert.throws(() => checkWaiverReset({ ...state, week_number: 1 }, 2, waiverResetAt('2026-11-01')), /calendar week/)
})

test('a traded conditional drop changes roster room without changing the submitted claim', () => {
  const submitted = '2025-10-27T14:00:00Z', at = Date.parse('2025-10-30T07:00:00Z')
  const batch = { ...input, mode: 'rolling', claims: [{ id: 'claim', member: 'a', player: 'target', drop: 'traded', order: 1, submitted }], rosterCounts: { ...input.rosterCounts, a: 1 } }
  const move = { playerId: 'traded', owner: 'b', at: Date.parse('2025-10-28T14:06:00Z') }
  assert.equal(waiverOutcomes(batch, { moves: [move], at }).rosterCounts.a, 2)
  assert.equal(batch.claims[0].drop, 'traded')
  for (const ignored of [{ ...move, owner: 'a' }, { ...move, at: at + 1 }, { ...move, at: Date.parse(submitted) - 1 }]) {
    assert.equal(waiverOutcomes(batch, { moves: [ignored], at }).rosterCounts.a, 1)
  }
  const full = waiverOutcomes({ ...batch, rosterCounts: input.rosterCounts }, { moves: [move], at })
  assert.equal(full.claims.claim, 'failed_roster')
  assert.equal(full.rosterCounts.a, 3)
})

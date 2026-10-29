import assert from 'node:assert/strict'
import test from 'node:test'
import { checkWaiverHold, nextWaiverRun, assertPendingWaivers, assertWeeklyAddLimit, readWaiverClaims, waiverDrop, waiverRosterRefills } from './waiver-scenarios.mjs'

const members = ['a', 'b', 'c', 'd']
const claims = [
  { id: 'a1', member: 'a' }, { id: 'a2', member: 'a' },
  { id: 'b1', member: 'b' }, { id: 'c1', member: 'c' },
  { id: 'c2', member: 'c' }, { id: 'd1', member: 'd' },
]

test('weekly add limits use scheduled claims and reject an unrelated pickup error', async () => {
  const user = { memberId: 'member', userId: 'user' }
  const calls = []
  const c = { leagueId: 'league', rpc: async (...args) => {
    calls.push(args)
    return { code: 'PA001', message: 'Weekly add limit reached (1/1 adds used this week).' }
  } }
  await assertWeeklyAddLimit(c, user, 'player')
  assert.deepEqual(calls, [[user, 'create_waiver_claim_atomic', {
    p_member_id: 'member', p_league_id: 'league', p_player_id: 'player', p_bid_amount: 0,
  }, 400]])
  c.rpc = async () => ({ code: 'PA002', message: 'Every pickup requires a scheduled waiver claim. Submit a claim instead.' })
  await assert.rejects(() => assertWeeklyAddLimit(c, user, 'player'))
})

test('pending claims are read through each owner under the production privacy policy', async () => {
  const reads = []
  const c = {
    users: [...members].reverse().map(memberId => ({ memberId })),
    rest: async (user, query) => {
      reads.push({ member: user.memberId, query })
      return claims.filter(row => row.member === user.memberId).map(row => ({ id: row.id, member_id: row.member, status: 'pending', processed_at: null, failure_reason: null }))
    },
  }
  const result = await readWaiverClaims(c, { seasonId: 'season', input: { claims } })
  assert.deepEqual(result.map(row => row.id).sort(), claims.map(row => row.id).sort())
  assert.equal(reads.length, 4)
  for (const read of reads) assert.ok(read.query.includes(`member_id=eq.${read.member}`))
})

test('the champion checkpoint rejects a missing claim and each changed pending field', async () => {
  const observed = claims.map(row => ({ id: row.id, member_id: row.member, status: 'pending', processed_at: null, failure_reason: null }))
  const scenario = { seasonId: 'season', input: { claims } }
  const context = rows => ({ users: members.map(memberId => ({ memberId })), rest: async user => rows.filter(row => row.member_id === user.memberId) })
  assert.ok((await assertPendingWaivers(context(observed), scenario)).passed)
  const corruptions = [
    rows => rows.pop(),
    rows => { rows[0].id = 'different' },
    rows => { rows[0].status = 'cancelled' },
    rows => { rows[0].processed_at = '2026-04-13T04:08:00Z' },
    rows => { rows[0].failure_reason = 'Unexpected cancellation' },
  ]
  for (const corrupt of corruptions) {
    const rows = structuredClone(observed)
    corrupt(rows)
    await assert.rejects(() => assertPendingWaivers(context(rows), scenario), /claim/)
  }
})

test('a donor who drops its last player submits a claim without an impossible conditional drop', () => {
  assert.equal(waiverDrop([], true), null)
  assert.equal(waiverDrop([{ player_id: 'owned' }], true), 'owned')
  assert.equal(waiverDrop([{ player_id: 'owned' }], false), null)
})

test('next-season waiver donors retain an NBA player and refill through available roster room', () => {
  const nba = id => ({ player_id: id, players: { nba_id: id, display_name: 'NBA player' } })
  const prospect = { player_id: 'rookie', players: { nba_id: 9999999, display_name: 'Synthetic Prospect 2026 1' } }
  const users = ['a', 'b', 'c'].map(memberId => ({ memberId }))
  const rosters = { a: [nba('a1'), nba('a2'), nba('a3')], b: [nba('b1')], c: [nba('c1'), prospect] }
  assert.deepEqual(waiverRosterRefills(users, rosters).map(u => u.memberId), ['b', 'c'])
  assert.throws(() => waiverRosterRefills(users, { ...rosters, b: [] }), /retains an NBA player/)
  assert.throws(() => waiverRosterRefills(users, { ...rosters, c: [nba('c1'), prospect, prospect] }), /roster limit/)
})


test('drop holds clear on the first league midnight at or after 48 elapsed hours', () => {
  for (const [droppedAt, clearsAt] of [
    ['2026-01-01T14:00:00Z', '2026-01-04T08:00:00Z'],
    ['2026-01-01T08:00:00Z', '2026-01-03T08:00:00Z'],
    ['2026-03-06T08:00:00Z', '2026-03-08T08:00:00Z'],
    ['2026-10-30T07:00:00Z', '2026-11-01T07:00:00Z'],
  ]) {
    checkWaiverHold(clearsAt, Date.parse(droppedAt))
    assert.throws(() => checkWaiverHold(new Date(Date.parse(clearsAt) - 3600000).toISOString(), Date.parse(droppedAt)))
  }
  assert.throws(() => checkWaiverHold('2026-01-03T14:00:00Z', Date.parse('2026-01-01T14:00:00Z')))
})

test('waiver runs use each league zone and its midnight DST offset',()=>{
  for(const [threshold,zone,expected] of [
    ['2026-11-01T05:00:00Z','America/Los_Angeles','2026-11-01T07:00:00Z'],
    ['2026-11-01T05:00:00Z','America/New_York','2026-11-02T05:00:00Z'],
    ['2026-03-08T05:00:00Z','America/New_York','2026-03-08T05:00:00Z'],
    ['2026-03-08T05:00:00Z','America/Los_Angeles','2026-03-08T08:00:00Z'],
    ['2026-01-01T00:00:00Z','Asia/Kathmandu','2026-01-01T18:15:00Z'],
  ])assert.equal(nextWaiverRun(Date.parse(threshold),zone),Date.parse(expected))
})

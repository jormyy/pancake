import assert from 'node:assert/strict'
import test from 'node:test'
import { officialAuctionPlan } from './official-auction.mjs'
import { officialProfile } from './scenario-profile.mjs'

const profile = officialProfile({ snapshotHashes: ['a'.repeat(64), 'b'.repeat(64)], actionSeed: 'auction-development' })
const players = Array.from({ length: 300 }, (_, index) => ({ id: `p${index}`, nba_id: String(index), position: ['PG', 'SG', 'SF', 'PF', 'C'][index % 5] }))

test('official auction has ten complete position-balanced rosters and independent budgets', () => {
  const plan = officialAuctionPlan(players, profile)
  assert.equal(plan.length, 200)
  assert.equal(new Set(plan.map(row => row.playerId)).size, 200)
  for (let team = 0; team < 10; team++) {
    const rows = plan.filter(row => row.team === team)
    assert.equal(rows.length, 20)
    assert.equal(rows.reduce((sum, row) => sum + row.bid, 0), 1000)
    assert.deepEqual(rows.slice(0, 5).map(row => row.position), ['PG', 'SG', 'SF', 'PF', 'C'])
  }
  assert.deepEqual(officialAuctionPlan([...players].reverse(), profile), plan)
  const other = officialAuctionPlan(players, { ...profile, actionSeed: 'auction-held-out' })
  assert.notDeepEqual(other.map(row => row.playerId), plan.map(row => row.playerId))
})

test('auction rejects incomplete pools and records missing precise positions', () => {
  assert.throws(() => officialAuctionPlan(players.slice(0, 199), profile), /requires 200/)
  const broad = officialAuctionPlan(players.map(row => ({ ...row, position: 'C' })), profile)
  assert.equal(broad.length, 200)
  assert.equal(broad.filter(row => !row.preferredSlotFilled).length, 60)
  assert.throws(() => officialAuctionPlan([...players, players[0]], profile), /unique/)
})

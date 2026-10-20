import assert from 'node:assert/strict'
import test from 'node:test'
import { checkAllocation, checkChampion, checkDraftOrder, rookieOrder } from './post-oracle.mjs'

test('independent rookie order, snake reversal and ownership reject corrupt observations', () => {
  const expectedOrder = rookieOrder(['c', 'a', 'b'], [{ member_id: 'a', week_number: 1, wins: 3, points_for: 9 }, { member_id: 'b', week_number: 1, wins: 1, points_for: 10 }])
  assert.deepEqual(expectedOrder, ['b', 'a', 'c'])
  const picks = [], assets = []
  for (let round = 1; round <= 2; round++) for (let position = 1; position <= 3; position++) {
    const id = `${round}:${position}`, owner = expectedOrder[round % 2 ? position - 1 : 3 - position]
    assets.push({ id, original_owner_id: owner, current_owner_id: 'traded' })
    picks.push({ round, pick_in_round: position, draft_pick_id: id, member_id: 'traded' })
  }
  const input = { expectedOrder, picks, assets, rounds: 2 }
  checkDraftOrder(input)
  assert.throws(() => checkDraftOrder({ ...input, expectedOrder: [...expectedOrder].reverse() }), /standings/)
  assert.throws(() => checkDraftOrder({ ...input, picks: [{ ...picks[0], member_id: 'wrong' }, ...picks.slice(1)] }), /ownership/)
})
test('allocation and champion checks fail when evidence is missing or changed', () => {
  const picks = [1, 2, 3].map(round => ({ round, original_owner_id: 'a', season_year: 2032 }))
  assert.equal(checkAllocation(picks, ['a'], 2032).picks, 3)
  assert.throws(() => checkAllocation(picks.slice(1), ['a'], 2032), /allocated/)
  const final = { id: 'final', is_finalized: true, home_points: 2, away_points: 1, home_member_id: 'a', away_member_id: 'b', winner_member_id: 'a' }
  checkChampion(final, final)
  assert.throws(() => checkChampion({ ...final, is_finalized: false }, final), /finalize/)
  assert.throws(() => checkChampion(final, { ...final, winner_member_id: 'b' }), /readable/)
})

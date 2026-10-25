import assert from 'node:assert/strict'
import test from 'node:test'
import { checkRoundReady, checkAllocation, checkChampion, checkDraftOrder, rookieOrder, checkPlayoffShape,checkRealDraftBoard } from './post-oracle.mjs'

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

test('the second-season bracket cannot lose a round, shift its span, or advance before the next Eastern date',()=>{
  const calendar={weeks:[{week_number:22,week_end:'2025-03-30'},{week_number:24,week_end:'2025-04-13'}]}
  const semi={playoff_round:1,week_number:22,end_week_number:22,is_finalized:true,home_points:2,away_points:1,finalized_at:'2025-03-31T05:00:00Z',created_at:'2025-03-26T14:00:00Z'}
  const rows=[{...semi,home_member_id:'a',away_member_id:'b',winner_member_id:'a'},{...semi,home_member_id:'c',away_member_id:'d',winner_member_id:'c'},{...semi,playoff_round:2,week_number:23,end_week_number:24,home_member_id:'a',away_member_id:'c',winner_member_id:'a',created_at:'2025-03-31T13:00:00Z'}]
  assert.ok(checkPlayoffShape(rows,4,22,[1,2],calendar).passed)
  assert.throws(()=>checkPlayoffShape(rows.slice(1),4,22,[1,2],calendar))
  assert.throws(()=>checkPlayoffShape([...rows.slice(0,2),{...rows[2],end_week_number:25}],4,22,[1,2],calendar))
  assert.throws(()=>checkPlayoffShape([...rows.slice(0,2),{...rows[2],created_at:'2025-03-31T03:59:59Z'}],4,22,[1,2],calendar))
})

test('the real draft board rejects missing, synthetic, linked, and ineligible imports',()=>{
  const raw=[{pick:1,name:'Real Rookie'}],players=[{nba_draft_number:1,display_name:'Real Rookie',years_exp:0,nba_id:null}]
  assert.ok(checkRealDraftBoard(raw,players).passed)
  assert.throws(()=>checkRealDraftBoard(raw,[]))
  assert.throws(()=>checkRealDraftBoard(raw,[{...players[0],display_name:'Synthetic Prospect 1'}]))
  assert.throws(()=>checkRealDraftBoard(raw,[{...players[0],nba_id:'future-nba-id'}]))
  assert.throws(()=>checkRealDraftBoard(raw,[{...players[0],years_exp:1}]))
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


test('initial bracket generation uses the last regular game date and requires finalized results', () => {
  const calendar = { weeks: [{ week_number: 21, week_end: '2025-03-23' }] }
  const regular = [{ week_number: 21, is_finalized: true, finalized_at: '2025-03-24T02:00:00Z' }]
  checkRoundReady('2025-03-24T13:00:00Z', regular, calendar)
  assert.throws(() => checkRoundReady('2025-03-24T03:59:59Z', regular, calendar), /Eastern date/)
  assert.throws(() => checkRoundReady('2025-03-24T13:00:00Z', [{ ...regular[0], is_finalized: false }], calendar), /finalized/)
  assert.throws(() => checkRoundReady('2025-03-24T13:00:00Z', regular, { weeks: [] }), /calendar/)
})

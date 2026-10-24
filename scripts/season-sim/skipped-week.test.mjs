import assert from 'node:assert/strict'
import test from 'node:test'
import { checkSkippedWeek, checkNextSchedule, skippedWeekActions } from './skipped-week.mjs'

const skipped = { week: 1, matchups: [], lineups: [{ week_number: 1, is_auto_set: true, slot_type: 'UTIL' }], standings: [], certificates: [], addCounts: [], expectedAdds: { a: 0 }, transactions: [], expectedTransactions: [] }

test('skipped weeks can retain daily lineups without fantasy results or transaction effects', () => {
  assert.equal(checkSkippedWeek(skipped).lineups, 1)
})

test('skipped weeks retain voided pair history but reject scores and results on those rows', () => {
  const row={week_number:1,matchup_type:'regular_season',is_voided:true,is_finalized:false,winner_member_id:null,home_points:0,away_points:0,home_max_possible_points:null,away_max_possible_points:null}
  const input={...skipped,matchups:[row]}
  assert.equal(checkSkippedWeek(input).voidedMatchups,1)
  for(const change of [{is_voided:false},{is_finalized:true},{winner_member_id:'a'},{home_points:0.1},{away_points:0.1},{home_max_possible_points:10}]){
    assert.throws(()=>checkSkippedWeek({...input,matchups:[{...row,...change}]}),/Skipped week 1/)
  }
})

test('skipped weeks reject phantom matchups, standings, certificates, adds and transactions', () => {
  const corruptions = [
    input => { input.matchups.push({ week_number: 1, home_points: 1 }) },
    input => { input.standings.push({ week_number: 1 }) },
    input => { input.certificates.push({ week_number: 1 }) },
    input => { input.addCounts.push({ member_id: 'a', week_number: 1, add_count: 1 }) },
    input => { input.transactions.push({ transaction_type: 'fa_add', member_id: 'a', player_id: 'phantom', related_claim_id: null }) },
  ]
  for (const corrupt of corruptions) {
    const input = structuredClone(skipped)
    corrupt(input)
    assert.throws(() => checkSkippedWeek(input), /Skipped week 1/)
  }
})

test('next-season schedule preserves calendar weeks and every member before the playoff boundary', () => {
  const members = ['a', 'b', 'c', 'd']
  const rows = [2, 3].flatMap(week_number => [{ week_number, matchup_type: 'regular_season', home_member_id: 'a', away_member_id: 'b' }, { week_number, matchup_type: 'regular_season', home_member_id: 'c', away_member_id: 'd' }])
  assert.deepEqual(checkNextSchedule(rows, members, 4, [1]).regularWeeks, [2, 3])
  assert.throws(() => checkNextSchedule([{ ...rows[0], week_number: 4 }, ...rows.slice(1)], members, 4, [1]), /calendar week 2/)
  assert.throws(() => checkNextSchedule([...rows, { ...rows[0], week_number: 1 }], members, 4, [1]), /playoff boundary/)
  assert.throws(() => checkNextSchedule([{ ...rows[0], home_member_id: 'c' }, ...rows.slice(1)], members, 4, [1]), /every member once/)
})

test('skipped-week add counts follow real claims and reset in the next calendar bucket', () => {
  const context = { leagueSeasonId: 'new', users: [{ memberId: 'a' }], waiverScenarios: [{ seasonId: 'new', targets: [{ member: 'a', player: 'dropped', droppedAt: 10 }], processAt: 30, input: { claims: [{ id: 'claim', member: 'a', player: 'won', drop: 'conditional' }] }, expected: { claims: { claim: 'succeeded' } } }] }
  const early = skippedWeekActions(context, 1, 20, 0, 100)
  assert.deepEqual(early.expectedAdds, { a: 0 })
  assert.equal(early.expectedTransactions.length, 1)
  const processed = skippedWeekActions(context, 1, 40, 0, 100)
  assert.deepEqual(processed.expectedAdds, { a: 1 })
  assert.deepEqual(processed.expectedTransactions.map(row => row.transaction_type), ['fa_drop', 'waiver_add', 'waiver_drop'])
  assert.deepEqual(skippedWeekActions(context, 2, 110, 100, 200).expectedAdds, { a: 0 })
  assert.ok(checkSkippedWeek({ ...skipped, addCounts: [{ member_id: 'a', week_number: 1, add_count: 1 }], ...processed, transactions: processed.expectedTransactions }).passed)
})

test('waiver transaction expectations retain a traded conditional drop on its new roster', () => {
  const submitted = '2025-10-27T14:00:00Z', movedAt = Date.parse('2025-10-28T14:00:00Z'), processAt = Date.parse('2025-10-30T07:00:00Z')
  const c = { leagueSeasonId: 'new', users: [{ memberId: 'a' }], identityMoves: [{ playerId: 'counter', owner: 'b', at: movedAt }], waiverScenarios: [{ seasonId: 'new', targets: [], processAt, input: { claims: [{ id: 'claim', member: 'a', player: 'target', drop: 'counter', submitted }] }, expected: { claims: { claim: 'succeeded' } } }] }
  const result = skippedWeekActions(c, 2, processAt + 1, Date.parse(submitted), processAt + 2)
  assert.deepEqual(result.expectedAdds, { a: 1 })
  assert.deepEqual(result.expectedTransactions.map(row => [row.transaction_type, row.player_id]), [['waiver_add', 'target']])
})

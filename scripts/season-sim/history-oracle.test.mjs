import assert from 'node:assert/strict'
import test from 'node:test'
import { checkSeasonHistory } from './history-oracle.mjs'

const before = { matchups: [{ id: 'final', home_points: 30, away_points: 20, winner_member_id: 'a', finalized_at: '2026-04-13T04:08:00Z', score_read_started_at: 'old' }], standings: [{ id: 'standing', member_id: 'a', week_number: 22, wins: 1, points_for: 30, waiver_priority: 1, created_at: 'old' }] }
const after = { matchups: [{ ...before.matchups[0], score_read_started_at: 'refresh' }], standings: [{ ...before.standings[0], created_at: 'refresh', waiver_priority: 5 }] }

test('score certification can refresh timestamps and the independently expected waiver priority', () => {
  assert.ok(checkSeasonHistory(before, after, { a: 5 }).passed)
})

test('history still rejects changed scores, winners, finalization, standings, rows and unexpected priority', () => {
  const corruptions = [
    rows => { rows.matchups[0].home_points++ },
    rows => { rows.matchups[0].winner_member_id = 'b' },
    rows => { rows.matchups[0].finalized_at = 'changed' },
    rows => { rows.standings[0].wins++ },
    rows => { rows.standings[0].points_for++ },
    rows => { rows.standings[0].waiver_priority = 99 },
    rows => { rows.matchups.pop() },
    rows => { rows.standings[0].id = 'replaced' },
  ]
  for (const corrupt of corruptions) {
    const rows = structuredClone(after)
    corrupt(rows)
    assert.throws(() => checkSeasonHistory(before, rows, { a: 5 }))
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { scoreCorruptionControls } from './oracle-controls.mjs'

const input = { matchups: [{ id: 'm', home_member_id: 'a', away_member_id: 'b', home_points: 7, away_points: 0, home_max_possible_points: 7, away_max_possible_points: 0, matchup_type: 'regular_season', week_number: 1, is_finalized: true, winner_member_id: 'a' }], starters: [{ member_id: 'a', week_number: 1, game_id: 'g', player_id: 'p', points: 7 }], settings: { points: 1 } }

test('real input corruption controls detect each mutation and preserve input', () => {
  const original = structuredClone(input)
  assert.equal(scoreCorruptionControls(input).length, 4)
  assert.deepEqual(input, original)
  assert.throws(() => scoreCorruptionControls(input, () => {}), /did not detect deliberate score/)
  assert.throws(() => scoreCorruptionControls({ ...input, matchups: [{ ...input.matchups[0], home_points: 999 }] }))
})

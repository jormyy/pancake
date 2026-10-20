import assert from 'node:assert/strict'
import test from 'node:test'
import { checkMatchupPoints, checkWeeklyRows, expectedWinner } from './score-oracle.mjs'

const matchup = { id: 'm', home_member_id: 'a', away_member_id: 'b', home_points: 7, away_points: 0, home_max_possible_points: 7, away_max_possible_points: 0, matchup_type: 'regular_season', week_number: 1, is_finalized: true, winner_member_id: 'a' }
const starters = [{ member_id: 'a', week_number: 1, game_id: 'g', player_id: 'p', points: 7 }]
const input = { matchups: [matchup], starters, settings: { points: 1 }, expectedCount: 1 }
test('live and multiweek scores reject altered totals and missing rows', () => {
  assert.equal(checkMatchupPoints(input).checked, 2)
  assert.throws(() => checkMatchupPoints({ ...input, matchups: [{ ...matchup, home_points: 8 }] }), /points/)
  assert.throws(() => checkMatchupPoints({ ...input, matchups: [{ ...matchup, home_max_possible_points: 8 }] }), /maximum/)
  assert.throws(() => checkMatchupPoints({ ...input, matchups: [] }), /must exist/)
  assert.equal(checkMatchupPoints({ ...input, matchups: [{ ...matchup, end_week_number: 2, home_points: 14, home_max_possible_points: 14 }], starters: [...starters, { ...starters[0], week_number: 2, game_id: 'g2' }] }).checked, 2)
})
test('playoff tie picks higher maximum then home; regular ties remain ties', () => {
  assert.equal(expectedWinner({ ...matchup, home_points: 0, matchup_type: 'playoff_final', away_max_possible_points: 8 }), 'b')
  assert.equal(expectedWinner({ ...matchup, home_points: 0, matchup_type: 'playoff_final', away_max_possible_points: 7 }), 'a')
  assert.equal(expectedWinner({ ...matchup, home_points: 0 }), null)
})
test('closed weeks need every result and standing; corrupted standing fails', () => {
  const standings = ['a', 'b'].map(member_id => ({ member_id, week_number: 1, wins: member_id === 'a' ? 1 : 0, losses: member_id === 'b' ? 1 : 0, ties: 0, points_for: member_id === 'a' ? 7 : 0, points_against: member_id === 'a' ? 0 : 7, max_possible_points: member_id === 'a' ? 7 : 0 }))
  const data = { matchups: [matchup], standings, members: ['a', 'b'], week: 1, expectedMatchups: 1 }
  assert.equal(checkWeeklyRows(data).standings, 2)
  assert.throws(() => checkWeeklyRows({ ...data, standings: [] }), /standings exist/)
  assert.throws(() => checkWeeklyRows({ ...data, standings: [{ ...standings[0], wins: 2 }, standings[1]] }), /standings/)
  assert.throws(() => checkWeeklyRows({ ...data, matchups: [{ ...matchup, is_finalized: false }] }), /finalizes/)
})

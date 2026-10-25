import assert from 'node:assert/strict'
import test from 'node:test'
import { checkMatchupPoints, checkWeeklyRows, checkStarterCoverage, rosterCandidates, expectedWinner } from './score-oracle.mjs'

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

test('maximum sums each player per date before selecting daily starters', () => {
  const lines = [{ member_id: 'a', week_number: 1, player_id: 'p', game_id: 'g1', lineup_date: '2026-10-20', points: 13 }, { member_id: 'a', week_number: 1, player_id: 'p', game_id: 'g2', lineup_date: '2026-10-20', points: 12 }]
  const candidates = [...lines, { member_id: 'a', week_number: 1, player_id: 'q', game_id: 'g3', lineup_date: '2026-10-20', points: 20 }]
  const data = { ...input, starters: lines, candidates, starterLimit: 1, matchups: [{ ...matchup, home_points: 25, home_max_possible_points: 25 }] }
  assert.equal(checkMatchupPoints(data).checked, 2)
  assert.throws(() => checkMatchupPoints({ ...data, matchups: [{ ...data.matchups[0], home_max_possible_points: 20 }] }), /maximum/)
})

test('finalized zero totals cannot hide absent starter coverage outside the planned empty members', () => {
  const observation = { source: { 'home:g:p': { value: 0 } } }
  assert.throws(() => checkStarterCoverage(matchup, observation), /away finalized matchup needs starter/)
  assert.ok(checkStarterCoverage(matchup, observation, ['b']))
  assert.throws(() => checkStarterCoverage(matchup, { source: {} }, ['b']), /home finalized matchup needs starter/)
})

test('maximum candidates retain a past bench player after a later drop and respect taxi returns', () => {
  const stat = { player_id: 'p', game_time: '2026-03-17T23:00:00Z', position: 'PG', points: 20.4 }
  const tx = (id, transaction_type, occurred_at, acquired_to_taxi = false) => ({ id, transaction_type, occurred_at, acquired_to_taxi, member_id: 'a', player_id: 'p' })
  const input = { members: ['a'], roster: [], stats: [stat, { ...stat, game_time: '2026-03-20T23:00:00Z' }], transactions: [tx('1', 'draft_won', '2026-03-16T14:00:00Z'), tx('2', 'waiver_drop', '2026-03-19T07:00:00Z')] }
  assert.deepEqual(rosterCandidates(input).map(row => row.game_time), ['2026-03-17T23:00:00Z'])
  const taxi = { ...input, transactions: [tx('1', 'draft_won', '2026-03-16T14:00:00Z', true), tx('2', 'taxi_return', '2026-03-18T14:00:00Z')] }
  assert.deepEqual(rosterCandidates(taxi).map(row => row.game_time), ['2026-03-20T23:00:00Z'])
  assert.deepEqual(rosterCandidates({ ...input, transactions: [], roster: [{ member_id: 'a', player_id: 'p', acquired_at: '2026-03-19T14:00:00Z' }] }).map(row => row.game_time), ['2026-03-20T23:00:00Z'])
})

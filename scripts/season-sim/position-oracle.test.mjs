import assert from 'node:assert/strict'
import test from 'node:test'
import { maximumAssignment } from './position-oracle.mjs'
import { checkMatchupPoints } from './score-oracle.mjs'

const slots = [{ slot_type: 'PG', slot_count: 1 }, { slot_type: 'C', slot_count: 1 }]
const player = (player_id, points, ...eligible_positions) => ({ player_id, points, eligible_positions })

test('maximum uses a legal position assignment instead of the highest two scores', () => {
  const players = [player('guard', 50, 'PG'), player('other-guard', 40, 'PG'), player('center', 10, 'C')]
  const result = maximumAssignment(players, slots)
  assert.equal(result.points, 60)
  assert.deepEqual(result.assignments.map(row => row.playerId).sort(), ['center', 'guard'])
  assert.equal(maximumAssignment([player('flex', 60, 'PG', 'C'), ...players], slots).points, 110)
  assert.equal(maximumAssignment([player('negative', -10, 'C'), player('unknown', 100)], slots).points, 0)
  assert.throws(() => maximumAssignment([players[0], players[0]], slots), /once/)
})

test('maximum agrees with exhaustive independent assignment on small conflicting rosters', () => {
  const layouts = [slots, [...slots, { slot_type: 'UTIL', slot_count: 1 }]]
  const exhaustive = (players, layout) => {
    const visit = (index, used) => index === layout.length ? 0 : Math.max(visit(index + 1, used), ...players.filter(row => !used.has(row.player_id) && (layout[index].slot_type === 'UTIL' || row.eligible_positions.includes(layout[index].slot_type))).map(row => row.points + visit(index + 1, new Set([...used, row.player_id]))))
    return visit(0, new Set())
  }
  for (let seed = 0; seed < 32; seed++) {
    const players = Array.from({ length: 5 }, (_, i) => player(String(i), (seed * 7 + i * 13) % 31 - 5, ...((seed >> i) & 1 ? ['PG', 'C'] : i % 2 ? ['C'] : ['PG'])))
    for (const layout of layouts) assert.equal(maximumAssignment(players, layout).points, exhaustive(players, layout))
  }
})

test('score acceptance rejects impossible position maximum and handles two games on one date', () => {
  const candidates = [player('guard', 50, 'PG'), player('other-guard', 40, 'PG'), player('center', 10, 'C')].map((row, i) => ({ ...row, member_id: 'home', week_number: 1, lineup_date: '2025-01-01', game_id: String(i) }))
  candidates.push({ ...candidates[2], game_id: 'second', points: 5 })
  const matchup = { id: 'm', home_member_id: 'home', away_member_id: 'away', home_points: 65, away_points: 0, home_max_possible_points: 65, away_max_possible_points: 0, week_number: 1, matchup_type: 'regular_season', is_finalized: true, winner_member_id: 'home' }
  const input = { matchups: [matchup], expectedCount: 1, starters: candidates.filter(row => row.player_id !== 'other-guard'), candidates, slots, settings: { points: 1 } }
  assert.equal(checkMatchupPoints(input).checked, 2)
  assert.throws(() => checkMatchupPoints({ ...input, matchups: [{ ...matchup, home_max_possible_points: 90 }] }), /maximum/)
  assert.throws(() => checkMatchupPoints({ ...input, starters: input.starters.slice(1) }), /points/)
})

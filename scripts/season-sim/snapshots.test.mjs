import assert from 'node:assert/strict'
import test from 'node:test'
import { compareFinalCounts, countingStats, snapshot } from './snapshots.mjs'

function syntheticProbe() {
  const player = personId => ({ personId, starter: '1', played: '1', statistics: Object.assign(Object.fromEntries(countingStats.map(key => [key, 0])), { minutes: 'PT12M00.00S', plusMinusPoints: 5 }) })
  const home = player(1), away = player(2)
  home.statistics.points = 2
  home.statistics.fieldGoalsAttempted = 1
  home.statistics.fieldGoalsMade = 1
  away.statistics.points = 3
  away.statistics.fieldGoalsAttempted = 1
  away.statistics.fieldGoalsMade = 1
  away.statistics.threePointersAttempted = 1
  away.statistics.threePointersMade = 1
  const box = { game: { gameId: 'SYNTHETIC-PROBE', homeTeam: { score: 2, players: [home, ...[3,4,5,6].map(player)] }, awayTeam: { score: 3, players: [away, ...[7,8,9,10].map(player)] } } }
  const playbyplay = { game: { gameId: 'SYNTHETIC-PROBE', actions: [
    { actionNumber: 1, orderNumber: 1, timeActual: '2025-10-21T23:40:00Z', period: 1, clock: 'PT11M00.00S', personId: 1, actionType: '2pt', shotResult: 'Made', pointsTotal: 2, scoreHome: '2', scoreAway: '0' },
    { actionNumber: 2, orderNumber: 2, timeActual: '2025-10-21T23:41:00Z', period: 1, clock: 'PT10M00.00S', personId: 2, actionType: '3pt', shotResult: 'Made', pointsTotal: 3, scoreHome: '2', scoreAway: '3' },
  ] } }
  return { box, playbyplay }
}

test('live slices exclude future plays and never borrow final minutes or plus-minus', () => {
  const { box, playbyplay } = syntheticProbe()
  const result = snapshot(box, playbyplay, '2025-10-21T23:40:30Z')
  assert.equal(result.game.homeTeam.players[0].statistics.points, 2)
  assert.equal(result.game.awayTeam.players[0].statistics.points, 0)
  assert.equal(result.game.homeTeam.players[0].statistics.minutes, 'PT1M00.00S')
  assert.equal(result.game.homeTeam.players[0].statistics.plusMinusPoints, 2)
  assert.equal(box.game.homeTeam.players[0].statistics.minutes, 'PT12M00.00S')
})

test('count audit accepts matching counts and rejects a changed final', () => {
  const { box, playbyplay } = syntheticProbe()
  assert.deepEqual(compareFinalCounts(box, playbyplay), [])
  box.game.homeTeam.players[0].statistics.points++
  assert.equal(compareFinalCounts(box, playbyplay)[0].field, 'points')
})

test('duplicate action numbers and absent historical times are refused', () => {
  const { box, playbyplay } = syntheticProbe()
  playbyplay.game.actions.push(playbyplay.game.actions[0])
  assert.throws(() => snapshot(box, playbyplay, '2025-10-22T00:00Z'), /Duplicate/)
  playbyplay.game.actions.pop()
  delete playbyplay.game.actions[0].timeActual
  assert.throws(() => snapshot(box, playbyplay, '2025-10-22T00:00Z'), /historical action time/)
})

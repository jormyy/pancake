import assert from 'node:assert/strict'
import test from 'node:test'
import { remapGame } from './next-season.mjs'

test('next-season synthetic mapping changes game identity and times without changing player lines', () => {
  const box = { game: { gameId: 'old', homeTeam: { players: [{ personId: 1, statistics: { points: 22 } }] } } }
  const pbp = { game: { actions: [{ timeActual: '2025-10-21T23:31:00Z', pointsTotal: 2 }] } }
  const mapped = remapGame(box, pbp, { time: '2025-10-21T23:30:00Z' }, { id: 'new', time: '2026-10-20T23:30:00Z', date: '2026-10-20', home: 'BOS', away: 'NYK' })
  assert.equal(mapped.pbp.game.actions[0].timeActual, '2026-10-20T23:31:00.000Z')
  assert.equal(mapped.box.game.gameId, 'new')
  assert.equal(box.game.gameId, 'old')
  assert.deepEqual(mapped.box.game.homeTeam.players, box.game.homeTeam.players)
})

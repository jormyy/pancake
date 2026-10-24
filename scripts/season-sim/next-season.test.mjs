import assert from 'node:assert/strict'
import test from 'node:test'
import { nextSeasonMorning, remapGame } from './next-season.mjs'

test('next-season mornings preserve worker time advanced by snapshot preparation', async () => {
  let clock = Date.parse('2026-10-20T14:00:11Z')
  const move = async at => {
    assert.ok(at >= clock, 'Snapshot preparation must not cause a later morning rewind')
    clock = at
  }
  await nextSeasonMorning('2026-10-20', move, async () => clock)
  assert.equal(clock, Date.parse('2026-10-20T14:00:11Z'))
  await nextSeasonMorning('2026-10-21', move, async () => clock)
  assert.equal(clock, Date.parse('2026-10-21T14:00:00Z'))
})

test('next-season synthetic mapping changes game identity and times without changing player lines', () => {
  const box = { game: { gameId: 'old', homeTeam: { players: [{ personId: 1, statistics: { points: 22 } }] } } }
  const pbp = { game: { actions: [{ timeActual: '2025-10-21T23:31:00Z', pointsTotal: 2 }] } }
  const mapped = remapGame(box, pbp, { time: '2025-10-21T23:30:00Z' }, { id: 'new', time: '2026-10-20T23:30:00Z', date: '2026-10-20', home: 'BOS', away: 'NYK' })
  assert.equal(mapped.pbp.game.actions[0].timeActual, '2026-10-20T23:31:00.000Z')
  assert.equal(mapped.box.game.gameId, 'new')
  assert.equal(box.game.gameId, 'old')
  assert.deepEqual(mapped.box.game.homeTeam.players, box.game.homeTeam.players)
})

test('synthetic Eastern game time follows the November DST boundary', () => {
  const input = { game: {} }, pbp = { game: { actions: [] } }
  for (const [time, expected] of [['2026-10-31T23:30:00Z', '2026-10-31T19:30:00-04:00'], ['2026-11-01T23:30:00Z', '2026-11-01T18:30:00-05:00']]) {
    const result = remapGame(input, pbp, { time }, { time, id: 'g', date: time.slice(0, 10), home: 'BOS', away: 'NYK' })
    assert.equal(result.box.game.gameEt, expected)
    assert.equal(Date.parse(result.box.game.gameEt), Date.parse(time))
    assert.notEqual(result.box.game.gameEt, `${time.slice(0, 10)}T12:00:00-04:00`)
  }
})

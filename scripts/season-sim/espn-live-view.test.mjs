import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { espnLiveEvent, espnLiveSummary } from './espn-live-view.mjs'

const { payload: { game: box } } = JSON.parse(await readFile(new URL('../../tests/fixtures/live-espn/2026-10-30T01-00-50.022Z-nba-boxscore-0022600144.json', import.meta.url), 'utf8'))
const game = { id: box.gameId, espnId: '401909893', date: '2026-10-29', time: '2026-10-30T00:00:00Z' }
const active = [box.homeTeam, box.awayTeam].flatMap(team => team.players.filter(player => player.played !== '0' && player.played !== 0 && player.status !== 'INACTIVE'))
const identities = new Map(active.map((player, index) => [player.personId, String(index + 100)]))

test('the season origin exposes the retained game sides, clock, season and identity', () => {
  const event = espnLiveEvent(game, box)
  assert.equal(event.id, game.espnId)
  assert.equal(event.season.year, 2027)
  assert.equal(event.status.type.state, 'in')
  assert.equal(event.status.displayClock, '02:17.0')
  assert.deepEqual(event.competitions[0].competitors.map(row => row.team.abbreviation), ['ATL', 'CLE'])
})

test('the ESPN season view preserves active NBA player points and paired shot columns', () => {
  const result = espnLiveSummary(game, box, identities, '2026-10-30T01:00:50Z')
  for (const [index, team] of [box.homeTeam, box.awayTeam].entries()) {
    const rows = result.boxscore.players[index].statistics[0].athletes
    assert.equal(rows.reduce((sum, row) => sum + Number(row.stats[1]), 0), team.score)
    assert.ok(rows.every(row => identities.has(active.find(player => String(identities.get(player.personId)) === row.athlete.id).personId)))
    assert.ok(rows.every(row => /^\d+-\d+$/.test(row.stats[2])))
  }
})

test('missing athlete or game identities fail rather than invent source links', () => {
  assert.throws(() => espnLiveSummary(game, box, new Map(), '2026-10-30T01:00:50Z'), /identity/)
  assert.throws(() => espnLiveEvent({ ...game, espnId: undefined }, box), /identity/)
})

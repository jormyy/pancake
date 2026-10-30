import assert from 'node:assert/strict'
import test from 'node:test'
import { recordedReplayRounds } from './live-fallback-check.mjs'

const iso = time => new Date(time).toISOString()
const records = Array.from({ length: 4 }, (_, index) => [
  { file: `${index}-scoreboard.json`, requestedAt: iso(index * 10000), receivedAt: iso(index * 10000 + 10) },
  { file: `${index}-summary-1.json`, requestedAt: iso(index * 10000 + 20), receivedAt: iso(index * 10000 + 30) },
  { file: `${index}-nba-scoreboard.json`, requestedAt: iso(index * 10000 + 40), receivedAt: iso(index * 10000 + 50) },
  { file: `${index}-nba-boxscore-1.json`, requestedAt: iso(index * 10000 + 60), receivedAt: iso(index * 10000 + 70) },
]).flat()

test('a 10-second recording replays at the production 20-second cadence with a final drain tick', () => {
  const rounds = recordedReplayRounds(records)
  assert.deepEqual(rounds.map(row => row.index), [0, 2, 3])
  assert.deepEqual(rounds.map(row => row.espnAt), [30, 20030, 40030])
  assert.deepEqual(rounds.map(row => row.nbaAt), [70, 20070, 40070])
})

test('each replay round only uses its own captured summaries and complete NBA responses', () => {
  const rounds = recordedReplayRounds(records)
  for (const round of rounds) {
    assert.equal(round.summaries.length, 1)
    assert.equal(round.summaries[0].file, `${round.index}-summary-1.json`)
    assert.ok(round.nbaAt >= Date.parse(records.find(row => row.file === `${round.index}-nba-boxscore-1.json`).receivedAt))
  }
})

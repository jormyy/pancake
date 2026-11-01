import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { loopback } from './common.mjs'
import { stateAt, validateSlate } from './fixture.mjs'
import { groupStatements, statementDeltas, workCheck } from './measure.mjs'
import { distribution } from './summary.mjs'

test('network guard rejects remote hosts and foreign local ports', () => {
  for (const host of ['https://example.com', 'postgres://db.supabase.co:5432/postgres', 'http://127.0.0.1.example.com:38000']) assert.throws(() => loopback(host, [38000]))
  assert.throws(() => loopback('http://127.0.0.1:54321', [38000]))
  assert.equal(loopback('http://127.0.0.1:38000', [38000]).hostname, '127.0.0.1')
})

test('training fixture keeps five live games and a final transition', async () => {
  const slate = JSON.parse(await readFile(new URL('./training.json', import.meta.url)))
  assert.equal(validateSlate(slate), 5)
  assert.equal(stateAt(slate, 0).filter(game => game.gameStatus === 2).length, 5)
  assert.equal(stateAt(slate, 240).filter(game => game.gameStatus === 3).length, 3)
  assert.notDeepEqual(stateAt(slate, 10), stateAt(slate, 0))
  assert.deepEqual(stateAt(slate, 240), stateAt(slate, 1000))
})

test('statement deltas retain duplicate query IDs across roles and sum function costs', () => {
  const row = { queryid: '7', dbid: '1', userid: '1', toplevel: true, query: 'select public.resolve_player_imports_atomic($1)', calls: 2, total_exec_time: 1000, wal_bytes: '10' }
  const other = { ...row, userid: '2', calls: 3, total_exec_time: 2000 }
  const delta = statementDeltas([], [row, other])
  const grouped = groupStatements(delta, 1)
  assert.equal(grouped.length, 1)
  assert.equal(grouped[0].calls, 5)
  assert.equal(grouped[0].execSecondsPerMinute, 3)
  assert.throws(() => statementDeltas([row], [{ ...row, calls: 1 }]))
})

test('work bar fails empty and stale-work-only windows', () => {
  assert.equal(workCheck({ statements: [], observedScoreChanges: 0, workerStarts: 0, cronRuns: 20, minutes: 4 }).passed, false)
  assert.equal(workCheck({ statements: [{ function: 'save_live_game_stats_atomic', calls: 100 }], observedScoreChanges: 0, workerStarts: 5, cronRuns: 20, minutes: 4 }).passed, false)
  assert.equal(workCheck({ statements: [{ function: 'save_live_game_stats_atomic', calls: 100 }], observedScoreChanges: 40, workerStarts: 5, cronRuns: 20, minutes: 4 }).passed, true)
  assert.equal(workCheck({ statements: [{ function: 'save_live_feed_snapshot_atomic', calls: 100 }], observedScoreChanges: 40, workerStarts: 5, cronRuns: 20, minutes: 4 }).passed, true)
})

test('spread reports observed range and sample count', () => {
  assert.deepEqual(distribution([1, 9, 4]), { median: 4, min: 1, max: 9, spread: 8, n: 3 })
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { upstreamRecorder } from './recorder.mjs'

test('continuation preserves every delivery class and earlier live coverage', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'season-recorder-'))
  try {
    const first = upstreamRecorder(directory)
    first.record({ path: '/boxscore_0022500001', gameId: '0022500001', gameStatus: 2, period: 1, gameClock: 'PT06M00.00S', at: '2025-10-21', provenance: 'REAL-DERIVED' })
    first.save()
    const resumed = upstreamRecorder(directory, { resume: true })
    resumed.record({ path: '/boxscore_0022500001', gameId: '0022500001', gameStatus: 3, provenance: 'REAL-RAW' })
    resumed.record({ path: '/injuries', provenance: 'SYNTHETIC' })
    assert.equal(resumed.report.deliveries, 3)
    assert.deepEqual(resumed.report.classes, { 'REAL-DERIVED': 1, 'REAL-RAW': 1, SYNTHETIC: 1 })
    assert.equal(resumed.report.games['0022500001'].finalRaw, 1)
    assert.equal(resumed.report.games['0022500001'].live['1:PT06M00.00S'], '2025-10-21')
    assert.equal(resumed.report.rawSampleRows, 3)
  } finally { rmSync(directory, { recursive: true }) }
})

test('continuation refuses a missing counter checkpoint', () => {
  assert.throws(() => upstreamRecorder('/nonexistent-season-sim-evidence', { resume: true }), /ENOENT/)
})

test('box-score timeline keeps repeated clocks after the general sample limit', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'season-recorder-'))
  try {
    const recorder = upstreamRecorder(directory)
    recorder.report.rawSampleLimit = 0
    const event = { path: '/boxscore_0022501063', kind: 'boxscore', gameId: '0022501063', gameStatus: 2, period: 2, gameClock: 'PT12M00.00S', provenance: 'REAL-DERIVED' }
    recorder.record({ ...event, at: 1774568400000 })
    recorder.record({ ...event, at: 1774568540000 })
    const rows = readFileSync(path.join(directory, 'boxscore-deliveries.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(rows.map(row => row.at), [1774568400000, 1774568540000])
    assert.equal(recorder.report.rawSampleRows, 0)
    assert.equal(recorder.report.games['0022501063'].live['2:PT12M00.00S'], 1774568540000)
  } finally { rmSync(directory, { recursive: true }) }
})

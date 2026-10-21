import { season } from './common.mjs'
import { shiftDay } from './season-model.mjs'
import assert from 'node:assert/strict'
import { probeRecovery } from './faults.mjs'
import { startRuntime } from './runtime.mjs'
import { sql } from './local-stack.mjs'

const date = process.argv[2] ?? shiftDay(season.start,5)
assert.match(date, /^\d{4}-\d{2}-\d{2}$/)
const next = new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString()
const runtime = await startRuntime(next)
try {
  const gameId = await sql(`SELECT nba_game_id FROM nba_games WHERE game_date='${date}' ORDER BY nba_game_id LIMIT 1`)
  console.log(await probeRecovery(runtime, date, gameId))
} finally { await runtime.close() }

import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { miniRoot, writeJson } from './common.mjs'
import { startRuntime } from './runtime.mjs'
import { setClock } from './clock.mjs'
import { dispatch } from './dispatch.mjs'
import { sql } from './local-stack.mjs'
import { postponementCases } from './postponements.mjs'

const schedule = /** @type {(text: string | Buffer) => any} */ (JSON.parse)(await readFile(path.join(miniRoot, 'fixtures/schedule.json'))).games
const games = /** @type {(text: string | Buffer) => any} */ (JSON.parse)(await readFile(path.join(miniRoot, 'fixtures/games.json'))).games
const nextDay = postponementCases(schedule, games).find(item => item.originalDate === '2026-01-24')
assert.ok(nextDay)
const runtime = await startRuntime('2026-01-24T14:00:00Z')
try {
  const outcomes = []
  for (const date of [nextDay.originalDate, nextDay.playedDate]) {
    await setClock({ at: `${date}T14:00:00Z`, rate: 0 })
    await dispatch("SELECT public.invoke_edge_function_at_et_time('sync-schedule',6,5)")
    const row = JSON.parse(await sql(`SELECT row_to_json(g) FROM (SELECT game_date,game_time,game_status_text FROM nba_games WHERE nba_game_id='${nextDay.gameId}') g`))
    assert.equal(row.game_date, date)
    assert.equal(row.game_status_text, date === nextDay.originalDate ? 'Postponed' : 'Scheduled')
    outcomes.push({ date, row })
  }
  await writeJson(path.join(miniRoot, 'evidence/sim-h008-replay-green.json'), { passed: true, outcomes, scope: 'Focused schedule-publication check; separate from season acceptance' })
  console.log(JSON.stringify(outcomes))
} finally { await runtime.close() }

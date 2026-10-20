import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { miniRoot, writeJson } from './common.mjs'
import { startRuntime } from './runtime.mjs'
import { resumeLeagueActions } from './actions.mjs'
import { prepareLineups } from './lineups.mjs'
import { publishedWeekNumber } from './calendar.mjs'
import { setClock } from './clock.mjs'
import { sql } from './local-stack.mjs'

const saved = /** @type {(text: string | Buffer) => any} */ (JSON.parse)(await readFile(path.join(miniRoot, 'state/league.json')))
const runtime = await startRuntime('2026-02-09T15:00:00Z')
try {
  const c = await resumeLeagueActions(runtime.keys, saved)
  const commissioner = c.users.find(user => user.id === saved.members[0].user_id)
  const week = publishedWeekNumber(await sql("SELECT week_number FROM season_weeks WHERE season_year=2026 AND '2026-02-09' BETWEEN week_start AND week_end"))
  assert.equal(week, 17)
  await c.rpc(commissioner, 'update_league_settings_atomic', { p_league_id: c.leagueId, p_settings: { skipped_weeks: [week] } })
  assert.equal(await sql(`SELECT count(*) FROM matchups WHERE league_season_id='${c.leagueSeasonId}' AND week_number=17 AND NOT is_voided`), '0')
  await setClock({ at: '2026-02-15T15:10:00Z', rate: 0 })
  const result = {}
  await prepareLineups(c, '2026-02-15', result)
  assert.equal(result.lineups.week, null)
  assert.equal(await sql(`SELECT count(*) FROM weekly_lineups WHERE league_season_id='${c.leagueSeasonId}' AND game_date='2026-02-15'`), '0')
  await writeJson(path.join(miniRoot, 'evidence/sim-h009-replay-green.json'), { scope: 'Focused saved-state API/calendar check; not season acceptance', skippedWeek: week, gap: result.lineups, passed: true })
  console.log('Real commissioner skip and empty-calendar lineup guard pass')
} finally { await runtime.close() }

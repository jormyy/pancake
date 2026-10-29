import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile, copyFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { labRoot, project, target, json, requireMini } from '../../scripts/perf-lab/common.mjs'
import { sql } from '../../scripts/perf-lab/database.mjs'
import { snapshot } from './l3e-snapshot.mjs'

await requireMini()
assert.equal(project, 'pt4bafablesq')
assert.equal(target.prefix, '632')
Object.assign(process.env, { SEASON_SIM_ROOT: labRoot, SEASON_SIM_PROJECT: project, SEASON_SIM_PORT_PREFIX: target.prefix, SEASON_SIM_CLI: 'supabase', SEASON_SIM_TWO_DAY: '1', SEASON_SIM_SNAPSHOT_ROOT: path.join(labRoot, 'snapshots') })
const scheduleFile = path.join(labRoot, 'fixtures/schedule.json')
const schedule = JSON.parse(await readFile(scheduleFile, 'utf8'))
await copyFile(scheduleFile, path.join(labRoot, 'schedule-before-window.json'), constants.COPYFILE_EXCL).catch(error => { if (error.code !== 'EEXIST') throw error })
const selected = schedule.games.filter(game => game.date <= '2025-10-24')
await writeFile(scheduleFile, `${JSON.stringify({ ...schedule, games: selected })}\n`)
await json(path.join(labRoot, 'schedule-window.json'), { end: '2025-10-24', before: schedule.games.length, after: selected.length })
await sql('SELECT pg_stat_reset(); SELECT extensions.pg_stat_statements_reset();')
await snapshot('replay-before')
try {
  const result = await (await import('../../scripts/perf-lab/two-day.mjs')).runTwoDay()
  await json(path.join(labRoot, 'l3e-replay-result.json'), result)
} finally {
  await snapshot('replay-after')
}

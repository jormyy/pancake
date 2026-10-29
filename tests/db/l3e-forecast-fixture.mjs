import assert from 'node:assert/strict'
import path from 'node:path'
import { labRoot, project, target, json, requireMini } from '../../scripts/perf-lab/common.mjs'

await requireMini()
assert.equal(project, 'pt4bafablesq')
Object.assign(process.env, { SEASON_SIM_ROOT: labRoot, SEASON_SIM_PROJECT: project, SEASON_SIM_PORT_PREFIX: target.prefix, SEASON_SIM_CLI: 'supabase', SEASON_SIM_TWO_DAY: '1' })
const { localKeys, sql } = await import('../../scripts/season-sim/local-stack.mjs')
const keys = localKeys()
process.env.SUPABASE_DB_URL = keys.DB_URL
process.env.SUPABASE_URL = keys.API_URL
const { setClock } = await import('../../scripts/season-sim/clock.mjs')
await setClock({ install: true, at: '2026-10-28T12:00:00Z', rate: 0 })
const matchups = JSON.parse(await sql(`SELECT json_agg(id) FROM (
  SELECT m.id FROM public.matchups m JOIN public.league_seasons s ON s.id=m.league_season_id AND s.is_current
  WHERE NOT m.is_voided ORDER BY m.week_number,m.id LIMIT 8
) selected`))
assert.ok(matchups.length)
for (const id of matchups) {
  assert.match(id, /^[a-f0-9-]{36}$/)
  await sql(`SELECT public.prepare_matchup_forecast_inputs('${id}'::uuid)`)
}
await sql('ANALYZE private.forecast_player_history; ANALYZE private.forecast_season_points;')
const tables = JSON.parse(await sql("SELECT json_agg(t) FROM (SELECT relname,n_live_tup,pg_relation_size(relid) AS bytes FROM pg_stat_user_tables WHERE relname IN ('forecast_player_history','forecast_season_points')) t"))
await json(path.join(labRoot, 'forecast-fixture.json'), { at: '2026-10-28T12:00:00Z', matchups, tables })
console.log(JSON.stringify({ matchups: matchups.length, tables }))

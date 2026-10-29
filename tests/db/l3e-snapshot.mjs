import assert from 'node:assert/strict'
import path from 'node:path'
import { labRoot, project, json, requireMini } from '../../scripts/perf-lab/common.mjs'
import { sql, statementSnapshot } from '../../scripts/perf-lab/database.mjs'

export async function snapshot(label) {
  await requireMini()
  assert.equal(project, 'pt4bafablesq')
  assert.match(label, /^[a-z0-9-]+$/)
  const tables = JSON.parse(await sql("SELECT json_agg(t) FROM (SELECT schemaname,relname,n_live_tup,seq_scan,seq_tup_read,idx_scan,idx_tup_fetch FROM pg_stat_user_tables WHERE relname IN ('player_game_stats','players','player_season_totals','job_run_details','work_items','forecast_player_history','roster_players') ORDER BY schemaname,relname) t"))
  const indexes = JSON.parse(await sql("SELECT json_agg(t) FROM (SELECT i.schemaname,i.relname,i.indexrelname,i.idx_scan,i.idx_tup_read,i.idx_tup_fetch,pg_relation_size(i.indexrelid) AS bytes,c.conname,c.contype FROM pg_stat_user_indexes i LEFT JOIN pg_constraint c ON c.conindid=i.indexrelid WHERE i.relname='player_game_stats' ORDER BY i.indexrelname) t"))
  const result = { label, at: new Date().toISOString(), tables, indexes, statements: await statementSnapshot() }
  await json(path.join(labRoot, `${label}-snapshot.json`), result)
  return result
}

if (process.argv[1]?.endsWith('/l3e-snapshot.mjs')) {
  const result = await snapshot(process.argv[2])
  console.log(JSON.stringify({ label: result.label, at: result.at, tables: result.tables, indexes: result.indexes }))
}

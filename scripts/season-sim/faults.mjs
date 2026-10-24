import { regularGame } from './season-model.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { config, writeJson, miniRoot } from './common.mjs'
import { sql } from './local-stack.mjs'
import { dispatch } from './dispatch.mjs'
import { setClock } from './clock.mjs'

export async function probeRecovery(runtime, date, gameId) {
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(regularGame(gameId),'Fault probes require a regular-season NBA game')
  const statement = `SELECT public.invoke_edge_function('sync-stats','{"date":"${date}"}')`
  const query = `SELECT json_agg(r ORDER BY game_id,player_id) FROM (SELECT * FROM player_game_stats WHERE game_id IN(SELECT id FROM nba_games WHERE game_date='${date}')) r`
  const before = JSON.parse(await sql(query))
  assert.ok(before?.length)
  const report = { date, gameId, provenance: 'SYNTHETIC', seed: 493, cases: [] }
  const record = async (name, outcomes) => {
    assert.deepEqual(JSON.parse(await sql(query)), before, `${name}: stored finals must remain intact`)
    report.cases.push({ name, outcomes })
    await writeJson(path.join(miniRoot, 'evidence/fault-recovery.json'), report)
  }
  const advance = async () => { const current = Number(await sql('SELECT extract(epoch FROM now())*1000')); await setClock({ at: new Date(current + 31 * 60000).toISOString(), rate: 30 }) }
  const faultFile = path.join(miniRoot, 'state/fault.json')
  try {
    for (const [name, fault] of /** @type {[string, Record<string, string | number>][]} */ ([
      ['cdn-503', { type: 'http', prefix: '/static/json/', status: 503 }],
      ['timeout', { type: 'http', prefix: `/static/json/liveData/boxscore/boxscore_${gameId}`, delayMs: 1500 }],
      ['box-404', { type: 'http', prefix: `/static/json/liveData/boxscore/boxscore_${gameId}`, status: 404 }],
      ['missing-final-player', { type: 'missing-player', gameId }],
    ])) {
      await advance()
      await writeJson(faultFile, { ...fault, provenance: 'SYNTHETIC', seed: 493 })
      const outcomes = await dispatch(statement, { allowFailure: true })
      assert.ok(outcomes.some(row => row.worker_status === 'error' || row.worker_status === 'failed' || row.status_code !== 200), `${name}: the pipeline must report missing input`)
      await record(name, outcomes)
      await writeJson(faultFile, {})
      await advance()
      await record(`${name}-recovery`, await dispatch(statement))
    }
    await runtime.stopEdge()
    try {
      const outcomes = await dispatch(statement, { allowFailure: true })
      assert.ok(outcomes.some(row => row.error_msg != null || row.status_code !== 200))
      await record('edge-down', outcomes)
    } finally { await runtime.startEdge() }
    await record('edge-recovery', await dispatch(statement))
    await sql(`ALTER DATABASE postgres SET app.supabase_url='http://host.lima.internal:${config.ports.fault}'`)
    try {
      const outcomes = await dispatch(statement, { allowFailure: true })
      assert.ok(outcomes.some(row => row.error_msg != null || row.status_code !== 200))
      await record('pg-net-unreachable', outcomes)
    } finally { await sql(`ALTER DATABASE postgres SET app.supabase_url='http://host.lima.internal:${config.ports.edge}'`) }
    await record('pg-net-recovery', await dispatch(statement))
    await advance()
    await record('duplicate-final-delivery', await dispatch(statement))
  } finally { await writeJson(faultFile, {}) }
  return report
}

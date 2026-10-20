import assert from 'node:assert/strict'
import path from 'node:path'
import { writeJson, miniRoot } from './common.mjs'
import { sql } from './local-stack.mjs'
import { dispatch } from './dispatch.mjs'
import { setClock } from './clock.mjs'

export async function probeOutOfOrder(gameId, at) {
  assert.match(gameId, /^00225\d{5}$/)
  assert.ok(Number.isFinite(Date.parse(at)))
  const query = `SELECT json_build_object('game',(SELECT json_build_object('status',status,'home',home_score,'away',away_score) FROM nba_games WHERE nba_game_id='${gameId}'),'stats',(SELECT json_agg(r ORDER BY player_id) FROM (SELECT player_id,points,rebounds,assists,minutes_played FROM player_game_stats WHERE game_id=(SELECT id FROM nba_games WHERE nba_game_id='${gameId}')) r))`
  const before = JSON.parse(await sql(query))
  assert.equal(before.game.status, 'InProgress')
  assert.ok(before.stats?.length)
  await writeJson(path.join(miniRoot, 'state/fault.json'), { type: 'out-of-order', gameId, at, seed: 493, provenance: 'SYNTHETIC' })
  try {
    const dispatches = await dispatch('SELECT public.invoke_live_poll_if_due()', { allowFailure: true })
    const after = JSON.parse(await sql(query))
    const passed = JSON.stringify(after) === JSON.stringify(before)
    await writeJson(path.join(miniRoot, 'evidence/out-of-order.json'), { gameId, at, provenance: 'SYNTHETIC', seed: 493, before, after, dispatches, passed })
    assert.deepEqual(after, before, 'Older live snapshots must not regress stored scores or player lines')
  } finally {
    await writeJson(path.join(miniRoot, 'state/fault.json'), {})
  }
}

export async function probeRecovery(runtime, date, gameId) {
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/)
  assert.match(gameId, /^00225\d{5}$/)
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
    await sql("ALTER DATABASE postgres SET app.supabase_url='http://host.lima.internal:56289'")
    try {
      const outcomes = await dispatch(statement, { allowFailure: true })
      assert.ok(outcomes.some(row => row.error_msg != null || row.status_code !== 200))
      await record('pg-net-unreachable', outcomes)
    } finally { await sql("ALTER DATABASE postgres SET app.supabase_url='http://host.lima.internal:56281'") }
    await record('pg-net-recovery', await dispatch(statement))
    await advance()
    await record('duplicate-final-delivery', await dispatch(statement))
  } finally { await writeJson(faultFile, {}) }
  return report
}

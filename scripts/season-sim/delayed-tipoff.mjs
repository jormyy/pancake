import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { miniRoot, sha256, writeJson } from './common.mjs'
import { fixtureStore } from './fixtures.mjs'
import { localKeys, sql, sqlJson } from './local-stack.mjs'
import { orderedActions, snapshot } from './snapshots.mjs'

export function checkFirstQuarterPolling(ticks) {
  assert.ok(ticks.length > 0, 'The fixture must supply first-quarter cron ticks')
  assert.ok(ticks.some(row => row.work > 0), 'Production live polling must reach the first quarter')
}

export async function probeDelayedTipoff() {
  const gameId = '0022501063'
  const store = await fixtureStore(path.join(miniRoot, 'fixtures'))
  const games = JSON.parse(await readFile(path.join(miniRoot, 'fixtures/games.json'), 'utf8')).games
  const game = games.find(row => row.id === gameId)
  assert.ok(game, 'The pinned delayed-tipoff game is required')
  const box = await store.json(`boxscore-${gameId}`)
  const pbp = await store.json(`playbyplay-${gameId}`)
  const quarter = orderedActions(pbp).filter(row => row.period === 1)
  assert.ok(quarter.length > 0)
  const start = Date.parse(quarter[0].timeActual)
  const end = Date.parse(quarter.at(-1).timeActual)
  const checkedAt = new Date(Date.parse(game.time) + 600000).toISOString()
  assert.ok(start > Date.parse(checkedAt), 'This fixture must tip after the scheduled ten-minute polling window')
  const report = { gameId, scheduledAt: game.time, checkedAt, quarterStart: new Date(start).toISOString(), quarterEnd: new Date(end).toISOString(),
    inputs: { fixture: 'REAL-DERIVED from pinned REAL-RAW NBA play-by-play', probeState: 'SYNTHETIC rollback-only reconstruction of the retained pre-tipoff check', pbpSha256: store.manifest.get(`playbyplay-${gameId}`).sha256 },
    startedAt: new Date().toISOString(), passed: false, ticks: [] }
  const keys = localKeys()
  process.env.SUPABASE_DB_URL = keys.DB_URL
  const stateQuery = `SELECT json_build_object('game',(SELECT row_to_json(g) FROM nba_games g WHERE nba_game_id='${gameId}'),'attempt',(SELECT row_to_json(s) FROM private.live_poll_game_state s JOIN nba_games g ON g.id=s.game_id WHERE g.nba_game_id='${gameId}'))`
  const before = await sql(stateQuery)
  assert.ok(JSON.parse(before).game, 'Load this game through schedule ingestion before running the probe')
  assert.equal(Number(await sql("SELECT count(*) FROM edge_invocations WHERE worker_status IN ('pending','running')")), 0, 'Stop active workers before the rollback-only probe')
  report.functionSha256 = sha256(await sql("SELECT pg_get_functiondef('public.get_live_poll_work(timestamptz)'::regprocedure)"))
  try {
    await sql('BEGIN')
    await sql(`UPDATE nba_games SET status='Scheduled',game_status_text='Scheduled',stats_synced_at=NULL WHERE nba_game_id='${gameId}'`)
    await sql(`INSERT INTO private.live_poll_game_state(game_id,checked_at) SELECT id,'${checkedAt}' FROM nba_games WHERE nba_game_id='${gameId}' ON CONFLICT(game_id) DO UPDATE SET checked_at=excluded.checked_at,stats_attempted_at=NULL`)
    report.ticks = await sqlJson(`SELECT json_agg(json_build_object('at',t,'work',(SELECT count(*) FROM public.get_live_poll_work(t) WHERE nba_game_id='${gameId}')) ORDER BY t) FROM generate_series('${new Date(Math.ceil(start / 120000) * 120000).toISOString()}'::timestamptz,'${new Date(end).toISOString()}'::timestamptz,interval '2 minutes') t`, 'Delayed-tipoff production work selection')
    for (const row of report.ticks) {
      const view = snapshot(box, pbp, row.at, false)
      assert.equal(view.game.gameStatus, 2, 'Origin must expose the game live at every sampled tick')
      assert.equal(view.game.period, 1, 'Origin must expose quarter one at every sampled tick')
      row.fixturePeriod = view.game.period
      row.fixtureClock = view.game.gameClock
    }
    checkFirstQuarterPolling(report.ticks)
    report.passed = true
  } catch (error) {
    report.failure = { name: error.name, message: error.message }
    throw error
  } finally {
    await sql('ROLLBACK')
    report.retainedStateUnchanged = before === await sql(stateQuery)
    report.finishedAt = new Date().toISOString()
    await writeJson(path.join(miniRoot, 'evidence/delayed-tipoff-probe.json'), report)
    assert.ok(report.retainedStateUnchanged, 'The probe must preserve retained game and attempt rows')
  }
  return report
}

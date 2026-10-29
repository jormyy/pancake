import assert from 'node:assert/strict'
import { sql } from './database.mjs'

export async function withDayPhase(fixture, phase, action, execute = sql) {
  assert.ok(['in-progress', 'final'].includes(phase))
  assert.match(fixture.today, /^\d{4}-\d{2}-\d{2}$/)
  const where = `game_date='${fixture.today}'`
  const saved = JSON.parse(await execute(`SELECT coalesce(json_agg(r),'[]') FROM (SELECT id,status,game_time,started_at FROM nba_games WHERE ${where}) r`))
  assert.ok(saved.length, 'The day phase needs actual game records')
  try {
    if (phase === 'final') await execute(`UPDATE nba_games SET status='Final',game_time=now()-interval '5 hours',started_at=now()-interval '5 hours' WHERE ${where}`)
    const evidence = JSON.parse(await execute(`SELECT json_build_object('day','${fixture.today}','phase','${phase}','games',count(*),'final',count(*) FILTER (WHERE status='Final'),'live',count(*) FILTER (WHERE status='InProgress')) FROM nba_games WHERE ${where}`))
    assert.ok(phase === 'final' ? evidence.final === evidence.games : evidence.live > 0, 'The requested game-day state is absent')
    return await action(evidence)
  } finally {
    if (phase === 'final') await execute(`UPDATE nba_games game SET status=saved.status,game_time=saved.game_time,started_at=saved.started_at FROM jsonb_populate_recordset(NULL::nba_games,'${JSON.stringify(saved).replaceAll("'", "''")}'::jsonb) saved WHERE game.id=saved.id`)
  }
}

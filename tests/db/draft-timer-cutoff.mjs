import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { sql, query, quote, clock, restoreClock, fixture, cleanup, env, record } from '../../scripts/mutation/draft/clock-stack.mjs'

const execute = promisify(execFile)
const fixtures = []
const source = JSON.parse(readFileSync('tests/fixtures/identity/games-2025.json','utf8'))
const opening = source.games.filter(g => /^002\d{7}$/.test(g.gameId)).sort((a,b)=>a.date.localeCompare(b.date))[0]
const cutoff = `${opening.date}T13:00:00.000Z`
const at = seconds => new Date(Date.parse(cutoff)+seconds*1000).toISOString()
const batch = () => sql('SELECT * FROM process_expired_snake_picks_atomic(500)')
const counts = d => query(`SELECT json_build_object('made',count(*) FILTER(WHERE player_id IS NOT NULL),'skipped',count(*) FILTER(WHERE skipped_at IS NOT NULL),'total',count(*),'distinctPlayers',count(DISTINCT player_id)) FROM snake_draft_picks WHERE draft_id=${quote(d)}`)
const games = query("SELECT coalesce(json_agg(g),'[]') FROM nba_games g WHERE nba_game_id='0022500001'")
const weeks = query("SELECT coalesce(json_agg(w),'[]') FROM season_weeks w WHERE season_year=2026")
let installed = false
async function start(offset) {
  clock(at(offset))
  const f = await fixture(2026); fixtures.push(f)
  sql(`UPDATE leagues SET playoff_start_week=3 WHERE id=${quote(f.league)}`)
  f.draft = JSON.parse(sql(`SELECT start_rookie_draft_atomic(${quote(f.league)},1,false,60,'skip_pick')`)).id
  return f
}
function complete(f) {
  const c = counts(f.draft)
  assert.deepEqual(c,{made:2,skipped:0,total:2,distinctPlayers:2},'Opening cutoff must fill skipped and pending picks')
  assert.equal(sql(`SELECT status FROM drafts WHERE id=${quote(f.draft)}`),'completed')
  assert.equal(Number(sql(`SELECT count(*) FROM roster_transactions WHERE league_id=${quote(f.league)} AND transaction_type='draft_won'`)),2)
  assert.equal(Number(sql(`SELECT count(*) FROM notification_outbox WHERE data->>'draftId'=${quote(f.draft)} AND event_type IN ('draft_on_clock','draft_coming_soon','draft_timer_expiring') AND NOT private.notif_is_stale(event_type,data)`)),0)
  assert.equal(Number(sql(`SELECT count(*) FROM draft_audit_logs WHERE draft_id=${quote(f.draft)} AND action='auto_pick'`)),2)
  assert.equal(Number(sql(`SELECT count(*) FROM draft_audit_logs WHERE draft_id=${quote(f.draft)} AND action='opening_night_completion'`)),1)
  assert.equal(Number(sql(`SELECT count(*) FROM notification_outbox WHERE event_type='draft_on_clock' AND data->>'draftId'=${quote(f.draft)}`)),2)
  assert.equal(Number(sql(`SELECT count(*) FROM notification_outbox WHERE event_type='draft_finished' AND data->>'draftId'=${quote(f.draft)}`)),2)
}
try {
  clock(at(-300),true); installed=true
  sql(`INSERT INTO nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status) VALUES(${quote(opening.gameId)},2026,1,${quote(opening.date)},${quote(opening.time)},${quote(opening.home)},${quote(opening.away)},'Scheduled') ON CONFLICT(nba_game_id) DO UPDATE SET season_year=2026,game_date=EXCLUDED.game_date;
    INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES(2026,1,'2025-10-21','2025-10-26'),(2026,2,'2025-10-27','2025-11-02'),(2026,3,'2025-11-03','2025-11-09') ON CONFLICT(season_year,week_number) DO UPDATE SET week_start=EXCLUDED.week_start,week_end=EXCLUDED.week_end;`)
  assert.equal(Number(sql('SELECT extract(epoch FROM private.draft_timer_opening_night_cutoff(2026))*1000')),Date.parse(cutoff))
  for (const offset of [-1,0,1]) {
    const f = await start(offset-60)
    clock(at(Math.min(offset,-1)))
    if (offset===-1) { batch(); assert.equal(counts(f.draft).skipped,1); assert.equal(counts(f.draft).made,0) }
    clock(cutoff)
    const backstop = execute('deno',['eval','--no-check',`const {runSeasonBoundary}=await import('./supabase/functions/_shared/seasonBoundary.ts');const r=await runSeasonBoundary(new Date(${JSON.stringify(cutoff)}),${JSON.stringify(f.league)});if(r.some(x=>x.error))throw Error(JSON.stringify(r));console.log(JSON.stringify(r));`],{env,timeout:30000})
    const expiry = execute('psql',[env.SUPABASE_DB_URL,'-XqAtv','ON_ERROR_STOP=1','-c','SELECT * FROM process_expired_snake_picks_atomic(500)'],{env,timeout:30000})
    const raced = await Promise.all([backstop,expiry])
    complete(f); batch(); complete(f)
    record(`cutoff-${offset}`,{provenance:'REAL-DERIVED opening fixture; SYNTHETIC league',cutoff,deadlineOffsetSeconds:offset,race:raced.map(x=>x.stdout),counts:counts(f.draft)})
  }
  const all = await start(-180)
  clock(at(-120)); batch(); clock(at(-60)); batch()
  assert.equal(counts(all.draft).skipped,2)
  assert.equal(sql(`SELECT status FROM drafts WHERE id=${quote(all.draft)}`),'completed')
  clock(cutoff)
  sql(`BEGIN; SET LOCAL app.supabase_url='http://kong:8000'; SET LOCAL app.edge_internal_token='local-database-ci-token';
    DO $$ DECLARE before_count int; BEGIN SELECT count(*) INTO before_count FROM edge_invocations; PERFORM invoke_close_expired_nominations_if_due(); IF (SELECT count(*) FROM edge_invocations)<>before_count+1 THEN RAISE EXCEPTION 'Cron gate must wake for an all-skipped completed draft'; END IF; END $$; ROLLBACK;`)
  batch(); complete(all)
  sql(`BEGIN; SET LOCAL app.supabase_url='http://kong:8000'; SET LOCAL app.edge_internal_token='local-database-ci-token';
    DO $$ DECLARE before_count int; BEGIN SELECT count(*) INTO before_count FROM edge_invocations; PERFORM invoke_close_expired_nominations_if_due(); IF (SELECT count(*) FROM edge_invocations)<>before_count THEN RAISE EXCEPTION 'Completed filled drafts must not keep waking the worker'; END IF; END $$; ROLLBACK;`)
  const disabled = await start(-60)
  clock(cutoff)
  sql(`BEGIN; CREATE OR REPLACE FUNCTION private.draft_timer_opening_night_completion_enabled() RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public AS 'SELECT false'; SELECT * FROM process_expired_snake_picks_atomic(500);
    DO $$ BEGIN IF (SELECT count(*) FROM snake_draft_picks WHERE draft_id=${quote(disabled.draft)} AND skipped_at IS NOT NULL)<>1 OR EXISTS(SELECT 1 FROM snake_draft_picks WHERE draft_id=${quote(disabled.draft)} AND player_id IS NOT NULL) THEN RAISE EXCEPTION 'Disabled cutoff must keep timer-only skip behavior'; END IF; END $$; ROLLBACK;`)
  record('cutoff-complete',{passed:true,cutoff,allSkippedRecovered:true,disabledTimerOnly:true})
} catch(error) { console.error('Primary test failure:',error); throw error } finally {
  cleanup(fixtures)
  sql("DELETE FROM nba_games WHERE nba_game_id='0022500001'; DELETE FROM season_weeks WHERE season_year=2026;")
  if(games.length) sql(`INSERT INTO nba_games SELECT * FROM json_populate_recordset(NULL::nba_games,${quote(JSON.stringify(games))})`)
  if(weeks.length) sql(`INSERT INTO season_weeks SELECT * FROM json_populate_recordset(NULL::season_weeks,${quote(JSON.stringify(weeks))})`)
  if(installed) restoreClock()
}

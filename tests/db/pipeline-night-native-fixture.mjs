import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { computeForecast } from '../../supabase/functions/matchup-forecast/compute.ts'

assert.equal(process.env.DOCKER_CONTEXT,'desktop-linux')
const url='postgresql://supabase_admin:postgres@127.0.0.1:64822/postgres'
const sql=input=>execFileSync('psql',[url,'-XqAtv','ON_ERROR_STOP=1'],{input,encoding:'utf8',maxBuffer:16*1024*1024}).trim()
const json=input=>JSON.parse(sql(input))
const literal=value=>`'${String(value).replaceAll("'","''")}'`
const fixture=JSON.parse(readFileSync('/tmp/fable-l7/evidence/inline-quality-live-cycle.json','utf8')).fixture
const game=json(`SELECT to_jsonb(g) FROM public.nba_games g WHERE id=${literal(fixture.game)};`)
const context=json(`SELECT to_jsonb(m) FROM public.matchups m WHERE id=${literal(fixture.context)};`)
const stats=json(`SELECT jsonb_agg(jsonb_build_object('player_id',id,'game_id',${literal(game.id)},'is_home',nba_team=${literal(game.home_team)},
  'minutes_played',12,'points',10,'rebounds',4,'assists',3,'steals',1,'blocks',0,'turnovers',1,'personal_fouls',1,
  'offensive_rebounds',1,'defensive_rebounds',3,'field_goals_made',4,'field_goals_attempted',8,'three_pointers_made',1,
  'three_pointers_attempted',3,'free_throws_made',1,'free_throws_attempted',2,'plus_minus',2,'double_double',false,'triple_double',false,'did_not_play',false) ORDER BY id)
  FROM (SELECT id,nba_team FROM public.players WHERE nba_team IN(${literal(game.home_team)},${literal(game.away_team)}) ORDER BY id LIMIT 30) p;`)
assert.equal(stats.length,30)
const snapshot={source:'nba',source_updated_at:new Date(Date.now()-30000).toISOString(),elapsed_seconds:1200,status:'InProgress',home_score:45,away_score:43,status_text:'Q2',stats}
const ingest=`public.save_live_feed_snapshot_atomic(${literal(game.id)},${literal(game.nba_game_id)},${literal(JSON.stringify(snapshot))}::jsonb)`
const empty=`UPDATE public.nba_games SET status='InProgress',started_at='2026-10-29T22:30:00Z',game_time='2026-10-29T22:30:00Z',live_stats_elapsed_seconds=NULL,live_scoreboard_elapsed_seconds=NULL WHERE id=${literal(game.id)};
  DELETE FROM private.live_feed_state WHERE game_id=${literal(game.id)}; DELETE FROM private.game_stat_revisions WHERE game_id=${literal(game.id)};`
const prepare=`SELECT public.prepare_matchup_forecast_inputs(${literal(context.id)});`
sql(empty+prepare)
const prepared=json(`SELECT public.get_prepared_matchup_forecast_context(${literal(context.id)});`)
const forecast=computeForecast(prepared)
const forecastLiteral=literal(JSON.stringify(forecast))+'::jsonb'
const payload=`(SELECT jsonb_agg(jsonb_build_object('id',id,'home_points',coalesce(home_points,0)+1,'away_points',coalesce(away_points,0))) FROM public.matchups WHERE league_season_id=${literal(context.league_season_id)} AND week_number=${context.week_number})`
const cases={
  'live-new':{prepare:empty,expression:ingest},
  'live-duplicate':{prepare:`${empty} SELECT ${ingest};`,expression:ingest},
  'prepare-fresh':{prepare:'DELETE FROM private.forecast_player_history; DELETE FROM private.forecast_projection_inputs; DELETE FROM private.forecast_season_points;',expression:`public.prepare_matchup_forecast_inputs(${literal(context.id)})`},
  'prepare-reuse':{prepare,expression:`public.prepare_matchup_forecast_inputs(${literal(context.id)})`},
  'context-compatible':{prepare,expression:`public.get_matchup_forecast_context(${literal(context.id)})`},
  'dispatcher-active':{prepare:`DELETE FROM private.work_items;
    UPDATE private.worker_controls SET paused=false,scheduler_level='normal',scheduler_checked_at=NULL,scheduler_healthy_since=NULL WHERE id;
    SELECT private.work_enqueue((ARRAY['stats-sync','matchup-forecasts','refresh-views','live-poll','sync-scores','process-trades','player-injuries','trade-revaluation'])[1+(n-1)%8],
      'native-'||n,now()-interval '1 minute',jsonb_build_object('fixture',n,'leagueId',${literal(context.league_id)},'matchupId',${literal(context.id)})) FROM generate_series(1,24) n;`,expression:'public.dispatch_work()'},
  'context-prepared':{prepare,expression:`public.get_prepared_matchup_forecast_context(${literal(context.id)})`},
  'forecast-write':{prepare:`${prepare} DELETE FROM private.forecast_refresh_requests;
    INSERT INTO private.matchup_forecast_queue(matchup_id,revision,dirty,claim_token,claimed_revision,claimed_at,claimed_fingerprint)
    VALUES(${literal(context.id)},900,true,'fabe1700-ffff-4000-8000-000000000001',900,now(),jsonb_build_object('validUntil',now()+interval '1 day'))
    ON CONFLICT(matchup_id) DO UPDATE SET revision=900,dirty=true,claim_token=EXCLUDED.claim_token,claimed_revision=900,claimed_at=EXCLUDED.claimed_at,claimed_fingerprint=EXCLUDED.claimed_fingerprint;`,
    expression:`public.complete_matchup_forecast(${literal(context.id)},900,'fabe1700-ffff-4000-8000-000000000001',${forecastLiteral},now()+interval '1 hour')`},
  'matchup-write':{prepare:`SELECT ${ingest};`,expression:`public.update_score_points_atomic(${literal(context.league_id)},${literal(context.league_season_id)},${context.week_number},${payload})`},
  'capture-score':{expression:`public.capture_score_inputs(${literal(context.league_season_id)},${context.week_number})`},
}
writeFileSync('/tmp/fable-l7/native-fixtures.json',JSON.stringify(cases))
process.stdout.write('Prepared ten native pipeline scenarios with 30-player box scores.\n')

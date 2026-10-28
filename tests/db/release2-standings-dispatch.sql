BEGIN;
\ir rules-support.sql
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='standings-dispatch-fixture';
DELETE FROM private.work_items;
DELETE FROM private.screen_refresh_queue;
DO $$
DECLARE f record; matchup uuid:=gen_random_uuid(); game uuid:=gen_random_uuid(); last_day date:=(now() AT TIME ZONE 'America/New_York')::date-1;
  payload jsonb; standings_payload jsonb; claim jsonb; initial_version bigint; finalized_version bigint; published jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9582);
  INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES(9582,1,last_day-6,last_day);
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,stats_synced_at)
    VALUES(game,'002release2standings',9582,1,last_day,'BOS','LAL','Final',now());
  INSERT INTO matchups(id,league_id,league_season_id,week_number,matchup_type,home_member_id,away_member_id)
    VALUES(matchup,f.league_id,f.season_id,1,'regular_season',f.member_ids[1],f.member_ids[2]);
  PERFORM private.enqueue_live_poll(((last_day-1)::text||' 12:00:00')::timestamp AT TIME ZONE 'America/New_York');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='sync-scores'),'week does not queue final scoring before its last game day');
  DELETE FROM private.work_items;
  SELECT version INTO initial_version FROM private.screen_refresh_queue WHERE league_season_id=f.season_id;
  PERFORM private.refresh_standings(f.league_id,f.season_id,initial_version);
  PERFORM pg_temp.check_rules((SELECT wins=0 FROM standings_current WHERE member_id=f.member_ids[1]),'unfinalized week does not enter current standings');
  UPDATE private.screen_refresh_queue SET dirty=false WHERE league_season_id=f.season_id;
  payload:=jsonb_build_array(jsonb_build_object('id',matchup,'winner_member_id',f.member_ids[1],
    'home_points',10,'away_points',5,'home_max_possible_points',10,'away_max_possible_points',5,
    'score_read_started_at',now(),'input_token',public.capture_score_inputs(f.season_id,1)));
  standings_payload:=jsonb_build_array(jsonb_build_object('member_id',f.member_ids[1],'wins',1,'losses',0,'ties',0,'points_for',10,'points_against',5,'max_possible_points',10));
  PERFORM public.finalize_score_week_atomic(f.league_id,f.season_id,1,payload,standings_payload);
  PERFORM pg_temp.check_rules((SELECT is_finalized AND finalized_at>=(last_day+1)::timestamp AT TIME ZONE 'America/New_York' FROM matchups WHERE id=matchup),'week finalizes after the last game day');
  SELECT version INTO finalized_version FROM private.screen_refresh_queue WHERE league_season_id=f.season_id;
  PERFORM pg_temp.check_rules(finalized_version>initial_version AND (SELECT dirty FROM private.screen_refresh_queue WHERE league_season_id=f.season_id),'finalization queues a new standings version');
  PERFORM pg_temp.check_rules((SELECT wins=0 FROM standings_current WHERE member_id=f.member_ids[1]),'current standings wait for the refresh worker');
  PERFORM public.dispatch_work();
  PERFORM pg_temp.check_rules((SELECT count(*)=1 AND bool_and(jobname='work-dispatcher' AND schedule='* * * * *') FROM cron.job WHERE jobname NOT IN ('io-hint-drain','io-cron-history-retention')),'only the minute dispatcher owns scheduling');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM edge_invocations invocation JOIN private.work_items work ON work.id=invocation.work_item_id
    WHERE invocation.function_name='refresh-views' AND work.kind='refresh-views'),'single dispatcher invokes the correlated refresh worker');
  SELECT value INTO claim FROM jsonb_array_elements(public.view_refresh_work(p_params:='{"operation":"claim","limit":10}')) WHERE value->>'seasonId'=f.season_id::text;
  PERFORM pg_temp.check_rules(claim->>'claimToken' IS NOT NULL,'refresh worker claims finalized standings');
  published:=public.view_refresh_work(f.league_id,NULL,claim||'{"operation":"complete","tradeValues":[]}');
  PERFORM pg_temp.check_rules(published='true'::jsonb,'worker publishes the finalized version');
  PERFORM pg_temp.check_rules((SELECT wins=1 AND losses=0 AND points_for=10 AND points_against=5 FROM standings_current WHERE member_id=f.member_ids[1])
    AND (SELECT losses=1 AND wins=0 AND points_for=5 FROM standings_current WHERE member_id=f.member_ids[2]),'refresh_standings publishes the final week records and points');
  PERFORM pg_temp.check_rules((SELECT NOT dirty FROM private.screen_refresh_queue WHERE league_season_id=f.season_id),'publication clears pending standings work');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;

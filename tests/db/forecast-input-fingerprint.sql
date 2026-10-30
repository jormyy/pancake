\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='10s';
\if :{?forecast_api_url}
SELECT set_config('app.supabase_url',:'forecast_api_url',true);
\else
SET LOCAL app.supabase_url='http://127.0.0.1:1';
\endif
SET LOCAL app.edge_internal_token='local-fingerprint-fixture';
\ir rules-support.sql
\ir scheduler-chunk-support.sql
CREATE FUNCTION pg_temp.finish_forecast(matchup uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE lease record;
BEGIN
  PERFORM pg_temp.drain_forecast_chunks();
  SELECT claim_token,claimed_revision AS revision,dirty INTO lease FROM private.matchup_forecast_queue WHERE matchup_id=matchup;
  IF NOT lease.dirty THEN RETURN; END IF;
  IF lease.claim_token IS NULL THEN SELECT * INTO lease FROM public.claim_matchup_forecasts(25) WHERE matchup_id=matchup; END IF;
  IF NOT public.complete_matchup_forecast(matchup,lease.revision,lease.claim_token,
    '{"modelVersion":"fixture","teams":[{},{}]}'::jsonb,now()+interval '6 hours') THEN RAISE EXCEPTION 'Fixture completion failed'; END IF;
END;
$$;
DO $$
DECLARE f record; matchup uuid:=gen_random_uuid(); unrelated uuid:=gen_random_uuid(); future uuid:=gen_random_uuid(); game uuid:=gen_random_uuid();
  p1 uuid:=gen_random_uuid(); p2 uuid:=gen_random_uuid(); p3 uuid:=gen_random_uuid(); stat uuid:=gen_random_uuid();
  today date:=(now() AT TIME ZONE 'America/New_York')::date; initial_revision bigint; initial_source bigint;
  before_hash jsonb; after_hash jsonb; lease record; iteration integer; source_run uuid:=gen_random_uuid();
  previous_game uuid:=gen_random_uuid(); history_revision bigint;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(4,9879);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9879,1,today-1,today+5);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9879,2,today+6,today+12);
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(matchup,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2]),
      (unrelated,f.league_id,f.season_id,1,f.member_ids[3],f.member_ids[4]);
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(future,f.league_id,f.season_id,2,f.member_ids[1],f.member_ids[2]);
  INSERT INTO public.players(id,first_name,last_name,nba_team,eligible_positions)
    VALUES(p1,'Fingerprint',p1::text,'BOS',ARRAY['PG']),
      (p2,'Fingerprint',p2::text,'LAL',ARRAY['PG']),(p3,'Fingerprint',p3::text,'MIA',ARRAY['PG']);
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],p1,'draft'),
      (f.league_id,f.season_id,f.member_ids[2],p2,'draft'),(f.league_id,f.season_id,f.member_ids[3],p3,'draft');
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,live_stats_elapsed_seconds)
    VALUES(game,'002-'||game,9879,1,today,now()-interval '1 hour','BOS','LAL','InProgress',600);
  PERFORM private.queue_matchup_forecasts(f.league_id);
  PERFORM pg_temp.finish_forecast(matchup);
  PERFORM pg_temp.finish_forecast(unrelated);
  PERFORM pg_temp.finish_forecast(future);
  SELECT revision INTO initial_revision FROM private.matchup_forecast_queue WHERE matchup_id=matchup;
  FOR iteration IN 1..20 LOOP PERFORM private.queue_matchup_forecasts(f.league_id); END LOOP;
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT NOT dirty AND revision=initial_revision FROM private.matchup_forecast_queue WHERE matchup_id=matchup),'unchanged inputs neither queue work nor advance the revision');
  UPDATE private.forecast_input_revisions SET revision=revision+1 WHERE kind='projection';
  INSERT INTO public.league_change_hints AS stored(league_id,topic,revision,details)
    VALUES(f.league_id,'resources',1,'[{"resource":"averages"}]')
    ON CONFLICT(league_id,topic) DO UPDATE SET revision=stored.revision+1,details=EXCLUDED.details;
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT NOT dirty FROM private.matchup_forecast_queue WHERE matchup_id=matchup),'league and preparation cache revisions do not queue forecasts');
  INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,game_date,slot_type,is_auto_set)
    VALUES(f.league_id,f.season_id,f.member_ids[3],p3,today+1,'UTIL',false);
  PERFORM private.queue_matchup_forecasts(f.league_id);
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT NOT dirty FROM private.matchup_forecast_queue WHERE matchup_id=matchup),'another matchup lineup does not queue this matchup');
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT dirty FROM private.matchup_forecast_queue WHERE matchup_id=unrelated),'a saved lineup queues its own matchup');
  PERFORM pg_temp.finish_forecast(unrelated);
  INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,game_date,slot_type,is_auto_set)
    VALUES(f.league_id,f.season_id,f.member_ids[2],p2,today+1,'UTIL',false);
  PERFORM private.queue_matchup_forecasts(f.league_id);
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT dirty FROM private.matchup_forecast_queue WHERE matchup_id=matchup),'the opponent lineup queues this matchup');
  PERFORM pg_temp.finish_forecast(matchup);
  before_hash:=private.matchup_forecast_input_fingerprint(matchup);
  UPDATE public.nba_games SET live_scoreboard_elapsed_seconds=900,live_stats_elapsed_seconds=900 WHERE id=game;
  PERFORM private.queue_matchup_forecasts(f.league_id);
  after_hash:=private.matchup_forecast_input_fingerprint(matchup);
  PERFORM pg_temp.check_rules(before_hash->'inputs'=after_hash->'inputs' AND before_hash->'clock'<>after_hash->'clock','the live clock is recorded separately from a changed input tick');
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT NOT dirty FROM private.matchup_forecast_queue WHERE matchup_id=matchup),'clock-only polls skip computation');
  INSERT INTO public.player_game_stats(id,player_id,game_id,game_date,season_year,points) VALUES(stat,p1,game,today,9879,1);
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT NOT dirty FROM private.matchup_forecast_queue WHERE matchup_id=matchup),'stat ingestion waits for score publication');
  UPDATE public.matchups SET home_points=1 WHERE id=matchup;
  PERFORM private.queue_matchup_forecasts(f.league_id);
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT dirty FROM private.matchup_forecast_queue WHERE matchup_id=matchup),'a changed stat line queues its matchup');
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT NOT dirty FROM private.matchup_forecast_queue WHERE matchup_id=unrelated),'a changed stat line does not queue another matchup');
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT NOT dirty FROM private.matchup_forecast_queue WHERE matchup_id=future),'a live stat line does not recompute next week through season averages');
  PERFORM pg_temp.finish_forecast(matchup);
  UPDATE public.player_game_stats SET points=points,updated_at=clock_timestamp() WHERE id=stat;
  PERFORM private.queue_matchup_forecasts(f.league_id);
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT NOT dirty FROM private.matchup_forecast_queue WHERE matchup_id=matchup),'identical stat polls skip computation');
  UPDATE public.player_game_stats SET points=2 WHERE id=stat;
  PERFORM private.queue_matchup_forecasts(f.league_id);
  PERFORM pg_temp.drain_forecast_chunks();
  SELECT * INTO lease FROM public.claim_matchup_forecasts(25) WHERE matchup_id=matchup;
  PERFORM pg_temp.check_rules(lease.claim_token IS NOT NULL,'a changed live tick can be claimed immediately');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.claim_matchup_forecasts(25) WHERE matchup_id=matchup),'one live tick has at most one active computation');
  UPDATE public.player_game_stats SET points=3 WHERE id=stat;
  PERFORM private.queue_matchup_forecasts(f.league_id);
  PERFORM pg_temp.check_rules(NOT public.complete_matchup_forecast(matchup,lease.revision,lease.claim_token,
    '{"modelVersion":"fixture","teams":[{},{}]}'::jsonb,now()+interval '1 hour'),'a later stat tick rejects the older result');
  PERFORM pg_temp.finish_forecast(matchup);
  SELECT revision INTO initial_source FROM private.forecast_input_revisions WHERE kind='source';
  INSERT INTO public.player_projections(player_id,season_year,week_number,projected_stat_points,fetched_at) VALUES(p1,9879,1,50,now());
  PERFORM pg_temp.check_rules((SELECT revision>initial_source FROM private.forecast_input_revisions WHERE kind='source'),'new projection sources advance their own revision');
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT dirty FROM private.matchup_forecast_queue WHERE matchup_id=matchup),'projection invalidation queues after the source revision is visible');
  PERFORM pg_temp.finish_forecast(matchup);
  PERFORM pg_temp.finish_forecast(unrelated);
  PERFORM pg_temp.finish_forecast(future);
  UPDATE public.player_projections SET projected_stat_points=projected_stat_points WHERE player_id=p1 AND season_year=9879;
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT NOT dirty FROM private.matchup_forecast_queue WHERE matchup_id=matchup),'identical projection writes skip computation');
  UPDATE public.matchup_forecasts SET valid_until=now()-interval '1 second' WHERE matchup_id=matchup;
  PERFORM private.enqueue_matchup_forecasts();
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT NOT dirty FROM private.matchup_forecast_queue WHERE matchup_id=matchup),'expiry does not compute unchanged inputs');
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT valid_until>now() FROM public.matchup_forecasts WHERE matchup_id=matchup),'unchanged expiry renews the cached forecast');
  SELECT revision INTO initial_source FROM private.forecast_input_revisions WHERE kind='source';
  INSERT INTO public.projection_sync_runs(id,source,projection_type,source_url,season_year,week_number,status)
    VALUES(source_run,'fantasypros','weekly_avg','https://www.fantasypros.com/nba/projections/overall.php',9879,1,'running');
  UPDATE public.projection_sync_runs SET status='failed',completed_at=now() WHERE id=source_run;
  PERFORM pg_temp.check_rules((SELECT revision=initial_source FROM private.forecast_input_revisions WHERE kind='source'),'running and failed projection attempts do not change forecast sources');
  INSERT INTO public.fantasypros_projection_rows(run_id,projection_type,source_url,source_row_number,season_year,week_number,
    fetched_at,source_player_name,normalized_player_name,player_id,match_status,points)
    VALUES(source_run,'weekly_avg','https://www.fantasypros.com/nba/projections/overall.php',1,9879,1,
      now(),'Fingerprint','fingerprint',p1,'matched',99);
  PERFORM pg_temp.check_rules((SELECT revision=initial_source FROM private.forecast_input_revisions WHERE kind='source'),'unpublished provider rows do not change forecast sources');
  UPDATE public.projection_sync_runs SET status='success',completed_at=now() WHERE id=source_run;
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT dirty FROM private.matchup_forecast_queue WHERE matchup_id=matchup),'provider publication queues its completed source');
  PERFORM pg_temp.finish_forecast(matchup);
  PERFORM pg_temp.finish_forecast(unrelated);
  PERFORM pg_temp.finish_forecast(future);
  UPDATE public.fantasypros_projection_rows SET points=100 WHERE run_id=source_run;
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT dirty FROM private.matchup_forecast_queue WHERE matchup_id=matchup),'a published provider correction queues new inputs');
  PERFORM pg_temp.finish_forecast(matchup);
  PERFORM pg_temp.finish_forecast(unrelated);
  PERFORM pg_temp.finish_forecast(future);
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES(previous_game,'002-'||previous_game,9879,1,today-1,
      (today-1+time '23:00') AT TIME ZONE 'America/New_York','BOS','LAL','InProgress');
  PERFORM pg_temp.finish_forecast(matchup);
  PERFORM pg_temp.finish_forecast(unrelated);
  PERFORM pg_temp.finish_forecast(future);
  SELECT revision INTO history_revision FROM private.forecast_input_revisions WHERE kind='history';
  INSERT INTO public.player_game_stats(player_id,game_id,game_date,season_year,points)
    VALUES(p1,previous_game,today-1,9879,1);
  PERFORM pg_temp.check_rules((SELECT revision=history_revision FROM private.forecast_input_revisions WHERE kind='history'),'a game still live after midnight does not invalidate final-game history');
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT NOT dirty FROM private.matchup_forecast_queue WHERE matchup_id=future),'a live after-midnight line leaves the future matchup idle');
  UPDATE public.nba_games SET status='Final' WHERE id=game;
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT dirty FROM private.matchup_forecast_queue WHERE matchup_id=matchup),'final status publishes the last game transition');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','private.matchup_forecast_input_fingerprint(uuid)','EXECUTE'),'clients cannot read private fingerprints');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;

BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='local-forecast-week-start-probe';
\ir rules-support.sql
DELETE FROM private.work_items WHERE kind='matchup-forecasts';
DO $$
DECLARE
  f record; v_started uuid:=gen_random_uuid(); v_future uuid:=gen_random_uuid();
  v_today date:=(now() AT TIME ZONE 'America/New_York')::date; v_tonight timestamptz:=now()+interval '5 hours';
  v_next timestamptz:=now()+interval '8 days'; v_due timestamptz; v_step integer;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9882);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
    VALUES(9882,1,v_today-1,v_today+5),(9882,2,v_today+6,v_today+12);
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(v_started,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2]),
          (v_future,f.league_id,f.season_id,2,f.member_ids[2],f.member_ids[1]);
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES(gen_random_uuid(),'002-wk1-'||gen_random_uuid(),9882,1,v_today,v_tonight,'BOS','NYK','Scheduled'),
          (gen_random_uuid(),'002-wk2-'||gen_random_uuid(),9882,2,v_today+8,v_next,'BOS','NYK','Scheduled');

  SELECT due_at INTO v_due FROM private.matchup_forecast_schedule WHERE matchup_id=v_started;
  PERFORM pg_temp.check_rules(v_due<=now(),'a started week without a forecast is due at once, not at first tipoff');
  SELECT due_at INTO v_due FROM private.matchup_forecast_schedule WHERE matchup_id=v_future;
  PERFORM pg_temp.check_rules(v_due=v_next,'a week that has not started still waits for its first tipoff');

  -- Run the per-minute input check as production does until no due request covers the league, then once more.
  FOR v_step IN 1..200 LOOP
    EXIT WHEN NOT private.matchup_forecast_refresh_pending(v_started);
    PERFORM private.complete_forecast_input_chunk();
  END LOOP;
  PERFORM private.complete_forecast_input_chunk();
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE matchup_id=v_started AND dirty),
    'the input check queues the started matchup for its first forecast');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='matchup-forecasts' AND status='pending'),
    'the input check enqueues the forecast worker for the queued matchup');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE matchup_id=v_future),
    'a week that has not started is not queued early');

  INSERT INTO public.matchup_forecasts(matchup_id,league_id,input_revision,forecast,calculated_at,valid_until)
    VALUES(v_started,f.league_id,1,'{"status":"available"}',now(),now()+interval '1 day');
  SELECT due_at INTO v_due FROM private.matchup_forecast_schedule WHERE matchup_id=v_started;
  PERFORM pg_temp.check_rules(v_due=v_tonight,'after its first forecast a matchup waits for the next tipoff again');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;

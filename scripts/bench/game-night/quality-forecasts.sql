\set ON_ERROR_STOP on
BEGIN;
\ir ../../../tests/db/rules-support.sql
DO $$
DECLARE f record; game uuid:=gen_random_uuid(); matchup uuid:=gen_random_uuid(); player uuid:=gen_random_uuid();
  day date:=(now() AT TIME ZONE 'America/New_York')::date; claim record;
  forecast jsonb:='{"modelVersion":"quality","teams":[{"winProbability":0.5},{"winProbability":0.5}]}';
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9543);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9543,49,day,day+6);
  INSERT INTO public.players(id,first_name,last_name,nba_team) VALUES(player,'Quality','Forecast','BOS');
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES(game,'quality-forecast',9543,49,day,now()-interval '1 hour','BOS','NYK','InProgress');
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(matchup,f.league_id,f.season_id,49,f.member_ids[1],f.member_ids[2]);
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,minutes_played)
    VALUES(player,game,9543,49,10,12);
  PERFORM private.queue_matchup_forecasts(NULL,matchup);
  PERFORM private.complete_forecast_input_chunk() FROM generate_series(1,100);
  SELECT * INTO claim FROM public.claim_matchup_forecasts(25) WHERE matchup_id=matchup;
  PERFORM pg_temp.check_rules(claim.claim_token IS NOT NULL,'initial live odds are claimable');
  PERFORM pg_temp.check_rules(public.complete_matchup_forecast(matchup,claim.revision,claim.claim_token,forecast,now()+interval '1 hour'),'initial win odds publish');
  UPDATE public.matchups SET home_points=12 WHERE id=matchup;
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.claim_matchup_forecasts(25) WHERE matchup_id=matchup),'live win odds keep the approved thirty-minute cycle');
  UPDATE public.matchup_forecasts SET calculated_at=now()-interval '31 minutes' WHERE matchup_id=matchup;
  UPDATE public.nba_games SET live_scoreboard_elapsed_seconds=2000 WHERE id=game;
  UPDATE private.forecast_refresh_requests SET available_at=now() WHERE matchup_id=matchup;
  UPDATE private.matchup_forecast_queue SET available_at=now() WHERE matchup_id=matchup;
  PERFORM private.queue_matchup_forecasts(NULL,matchup);
  PERFORM private.complete_forecast_input_chunk() FROM generate_series(1,100);
  SELECT * INTO claim FROM public.claim_matchup_forecasts(25) WHERE matchup_id=matchup;
  PERFORM pg_temp.check_rules(claim.claim_token IS NOT NULL,'win odds wake after thirty minutes');
  PERFORM pg_temp.check_rules(public.complete_matchup_forecast(matchup,claim.revision,claim.claim_token,forecast,now()+interval '1 hour'),'thirty-minute win odds publish');
  UPDATE public.nba_games SET status='Final' WHERE id=game;
  UPDATE public.matchups SET is_finalized=true,winner_member_id=f.member_ids[1] WHERE id=matchup;
  PERFORM private.queue_matchup_forecasts(NULL,matchup);
  PERFORM private.complete_forecast_input_chunk() FROM generate_series(1,100);
  SELECT * INTO claim FROM public.claim_matchup_forecasts(25) WHERE matchup_id=matchup;
  PERFORM pg_temp.check_rules(claim.claim_token IS NOT NULL,'matchup end wakes final odds');
  forecast:='{"modelVersion":"quality","teams":[{"winProbability":1},{"winProbability":0}]}';
  PERFORM pg_temp.check_rules(public.complete_matchup_forecast(matchup,claim.revision,claim.claim_token,forecast,now()+interval '1 hour'),'final win odds publish');
  PERFORM pg_temp.check_rules((SELECT (stored.forecast#>>'{teams,0,winProbability}')::numeric=1 AND valid_until>now()+interval '1 year' FROM public.matchup_forecasts stored WHERE matchup_id=matchup),'final odds stay available without further game polling');
END;
$$;
SELECT count(*) passed_checks FROM rules_checks;
ROLLBACK;

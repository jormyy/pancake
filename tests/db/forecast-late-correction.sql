BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='review-forecast';
\ir rules-support.sql
DO $$
DECLARE f record; old_match uuid:=gen_random_uuid(); new_match uuid:=gen_random_uuid(); due timestamptz;
  day date:=(now() AT TIME ZONE 'America/New_York')::date; old_input jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9538);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
    VALUES(9538,1,day-10,day-4),(9538,2,day,day+6);
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES('002-review-forecast',9538,2,day,'BOS','NYK','InProgress');
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id,is_finalized)
    VALUES(old_match,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2],true),
      (new_match,f.league_id,f.season_id,2,f.member_ids[1],f.member_ids[2],false);
  old_input:=private.matchup_forecast_input_fingerprint(old_match)||jsonb_build_object('validUntil',now()-interval '1 day');
  INSERT INTO private.matchup_forecast_queue(matchup_id,revision,dirty,finalized,input_fingerprint,computed_fingerprint)
    VALUES(old_match,1,false,true,old_input,old_input);
  UPDATE public.matchups SET home_points=20 WHERE id=old_match;
  due:=private.refresh_matchup_forecast_input(old_match);
  PERFORM pg_temp.check_rules(due>now(),'late correction rebuilds its expired deadline');
  PERFORM pg_temp.check_rules((SELECT dirty AND NOT finalized FROM private.matchup_forecast_queue WHERE matchup_id=old_match),
    'late correction becomes eligible for a final forecast');
  PERFORM private.complete_forecast_input_chunk() FROM generate_series(1,20);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE matchup_id=new_match),
    'late correction cannot starve a newer matchup');
  UPDATE public.matchups SET is_voided=true WHERE id=old_match;
  PERFORM pg_temp.check_rules(private.refresh_matchup_forecast_input(old_match) IS NULL,'voided request has no expired retry deadline');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;

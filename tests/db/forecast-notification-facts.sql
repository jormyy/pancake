BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='forecast-notification';
\ir rules-support.sql
DO $$
DECLARE f record; matchup uuid:=gen_random_uuid(); before_version bigint; before_messages bigint; body jsonb;
  day date:=(now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9533);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9533,1,day,day+6);
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(matchup,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2]);
  INSERT INTO public.matchup_forecasts(matchup_id,league_id,input_revision,forecast,valid_until)
    VALUES(matchup,f.league_id,1,'{"modelVersion":"test","teams":[{"winProbability":0.5},{"winProbability":0.5}]}',now()+interval '30 minutes');
  SET CONSTRAINTS ALL IMMEDIATE;
  SELECT version INTO before_version FROM public.league_versions WHERE league_id=f.league_id;
  SELECT count(*) INTO before_messages FROM realtime.messages WHERE topic='l1:league:'||f.league_id;
  UPDATE public.matchup_forecasts SET calculated_at=now()+interval '1 minute',valid_until=now()+interval '1 hour',input_revision=2 WHERE matchup_id=matchup;
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM pg_temp.check_rules((SELECT version=before_version FROM public.league_versions WHERE league_id=f.league_id),'unchanged forecast facts do not invalidate screens');
  PERFORM pg_temp.check_rules((SELECT count(*)=before_messages FROM realtime.messages WHERE topic='l1:league:'||f.league_id),'unchanged forecast facts do not broadcast');
  UPDATE public.matchup_forecasts SET forecast=jsonb_set(forecast,'{teams,0,winProbability}','0.6') WHERE matchup_id=matchup;
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM pg_temp.check_rules((SELECT version>before_version FROM public.league_versions WHERE league_id=f.league_id),'changed win probability still invalidates screens');
  SELECT scope INTO body FROM public.league_changes WHERE league_id=f.league_id ORDER BY version DESC LIMIT 1;
  PERFORM pg_temp.check_rules(body->'forecastMatchupIds' @> to_jsonb(ARRAY[matchup]),'forecast invalidation identifies its matchup');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;

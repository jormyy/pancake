BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='forecast-batch';
\ir rules-support.sql
CREATE TEMP TABLE forecast_batch_fixture(league_id uuid,user_ids uuid[],messages_before bigint);
DO $$
DECLARE f record; ids uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  tokens uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()]; idx integer; response jsonb; payload jsonb;
  messages_before bigint; day date:=(now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(6,9531);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9531,1,day,day+6);
  FOR idx IN 1..3 LOOP
    INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
      VALUES(ids[idx],f.league_id,f.season_id,1,f.member_ids[idx*2-1],f.member_ids[idx*2]);
    INSERT INTO private.matchup_forecast_queue(matchup_id,revision,dirty,claim_token,claimed_at,claimed_revision,claimed_fingerprint)
      VALUES(ids[idx],1,true,tokens[idx],now(),1,jsonb_build_object('inputs','fixture','clock','fixture','validUntil',now()+interval '1 hour'));
  END LOOP;
  DELETE FROM private.forecast_refresh_requests;
  SET CONSTRAINTS ALL IMMEDIATE;
  SELECT count(*) INTO messages_before FROM realtime.messages WHERE topic='l1:league:'||f.league_id;
  SET CONSTRAINTS ALL DEFERRED;
  SELECT jsonb_agg(jsonb_build_object('matchupId',ids[n],'revision',1,'claimToken',tokens[n],
    'forecast',CASE WHEN n=2 THEN '{}'::jsonb ELSE '{"modelVersion":"test","teams":[{},{}]}'::jsonb END,'validUntil',now()+interval '1 hour') ORDER BY n)
    INTO payload FROM generate_series(1,3)n;
  response:=public.complete_matchup_forecasts(payload);
  PERFORM pg_temp.check_rules(response->0->>'saved'='true' AND response->2->>'saved'='true','healthy forecast claims publish together');
  PERFORM pg_temp.check_rules(response->1->>'saved'='false' AND response->1->>'code'='22023','invalid forecast retains its own failure');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM public.matchup_forecasts WHERE matchup_id=ANY(ids)),'one failed forecast cannot roll back the healthy ones');
  INSERT INTO forecast_batch_fixture VALUES(f.league_id,f.user_ids,messages_before);
  PERFORM pg_temp.check_rules(public.complete_matchup_forecasts('[]')='[]','empty batches write nothing');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','public.complete_matchup_forecasts(jsonb)','EXECUTE'),'forecast batching stays worker-only');
END;
$$;
COMMIT;
BEGIN;
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO STRICT f FROM forecast_batch_fixture;
  PERFORM pg_temp.check_rules((SELECT count(*)=f.messages_before+1 FROM realtime.messages WHERE topic='l1:league:'||f.league_id),'forecast publication shares one committed transaction broadcast');
  DELETE FROM public.leagues WHERE id=f.league_id;
  DELETE FROM auth.users WHERE id=ANY(f.user_ids);
  DELETE FROM public.season_weeks WHERE season_year=9531;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
COMMIT;

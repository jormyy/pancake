BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='local-forecast-dispatch-probe';
\ir rules-support.sql
DO $$
DECLARE f record; matchup uuid:=gen_random_uuid(); lease record; result jsonb; outsider uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9560);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
    VALUES(9560,1,current_date,current_date+6);
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id,home_points,away_points)
    VALUES(matchup,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2],100,90);
  PERFORM pg_temp.check_rules((SELECT dirty FROM private.matchup_forecast_queue WHERE matchup_id=matchup),'new matchup queues a shared forecast');
  DELETE FROM private.matchup_forecast_queue WHERE matchup_id=matchup;
  PERFORM private.enqueue_matchup_forecasts();
  PERFORM pg_temp.check_rules((SELECT dirty FROM private.matchup_forecast_queue WHERE matchup_id=matchup),'scheduler discovers newly eligible periods without a viewer');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','public.claim_matchup_forecasts(integer)','EXECUTE'),'clients cannot claim forecast work');
  PERFORM pg_temp.check_rules(NOT has_table_privilege('authenticated','public.matchup_forecasts','INSERT'),'clients cannot forge cached forecasts');
  SELECT * INTO lease FROM public.claim_matchup_forecasts(25) WHERE matchup_id=matchup;
  PERFORM pg_temp.check_rules(lease.claim_token IS NOT NULL,'forecast worker receives a lease');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.claim_matchup_forecasts(25) WHERE matchup_id=matchup),'overlapping worker cannot claim same forecast');
  result:=jsonb_build_object('modelVersion','fixture','status','available','teams',jsonb_build_array(
    jsonb_build_object('memberId',f.member_ids[1],'projectedFinal',120,'winProbability',0.8),
    jsonb_build_object('memberId',f.member_ids[2],'projectedFinal',110,'winProbability',0.2)));
  UPDATE private.matchup_forecast_queue SET revision=revision+1 WHERE matchup_id=matchup;
  PERFORM pg_temp.check_rules(NOT public.complete_matchup_forecast(matchup,lease.revision,lease.claim_token,result,now()+interval '1 hour'),'old forecast cannot overwrite newer input');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.matchup_forecasts WHERE matchup_id=matchup),'rejected stale result changes no cache');
  SELECT * INTO lease FROM public.claim_matchup_forecasts(25) WHERE matchup_id=matchup;
  PERFORM pg_temp.check_rules(public.complete_matchup_forecast(matchup,lease.revision,lease.claim_token,result,now()+interval '1 hour'),'current input publishes one forecast');
  PERFORM pg_temp.check_rules(NOT public.complete_matchup_forecast(matchup,lease.revision,lease.claim_token,result,now()+interval '1 hour'),'repeated completion cannot publish again');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM pg_temp.check_rules((public.get_matchup_forecast(matchup)->>'stale')::boolean=false,'member reads current cached result');
  PERFORM pg_temp.check_rules(public.get_matchup_forecast(matchup)->'teams'=result->'teams','cache read preserves exact computed teams');
  PERFORM set_config('request.jwt.claim.sub',outsider::text,true);
  PERFORM pg_temp.reject_rules(format('SELECT public.get_matchup_forecast(%L)',matchup),'This matchup is not available.','outsider cannot read private forecast');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  UPDATE public.matchups SET home_points=101 WHERE id=matchup;
  PERFORM pg_temp.check_rules((public.get_matchup_forecast(matchup)->>'stale')::boolean,'score changes mark result stale immediately');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE matchup_id=matchup AND dirty),'score changes queue recalculation');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;

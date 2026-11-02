BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='forecast-patch';
\ir rules-support.sql
DO $$
DECLARE f record; matchup uuid:=gen_random_uuid(); full_view jsonb; patch jsonb; day date:=(now() AT TIME ZONE 'America/Los_Angeles')::date;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9530);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9530,1,day,day+6);
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(matchup,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2]);
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  full_view:=public.view_home(f.league_id,f.member_ids[1],jsonb_build_object('matchupId',matchup,'date',day,'compact',true));
  patch:=public.view_home(f.league_id,f.member_ids[1],jsonb_build_object('matchupId',matchup,'date',day,'compact',true,'section','forecast'));
  PERFORM pg_temp.check_rules(patch->>'section'='forecast','forecast read returns only the requested section');
  PERFORM pg_temp.check_rules(patch->'forecast' IS NOT DISTINCT FROM full_view->'forecast','forecast patch matches the full screen');
  PERFORM pg_temp.check_rules(patch->'matchup'->>'id'=matchup::text AND patch->'context'->>'seasonId'=f.season_id::text,'patch carries its matchup and season identity');
  PERFORM pg_temp.check_rules(NOT patch ? 'myLineup' AND NOT patch ? 'liveBasis' AND NOT patch ? 'liveStats','forecast read excludes unrelated payloads');
  PERFORM set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  PERFORM pg_temp.reject_rules(format('SELECT public.view_home(%L,%L,%L)',f.league_id,f.member_ids[1],jsonb_build_object('matchupId',matchup,'section','forecast')),'%This screen is not available.%','forecast section keeps membership authorization');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;

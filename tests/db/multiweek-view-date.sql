BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='review-date';
\ir rules-support.sql
DO $$
DECLARE f record; matchup uuid:=gen_random_uuid(); result jsonb; day date:=(now() AT TIME ZONE 'America/Los_Angeles')::date;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9539);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
    VALUES(9539,1,day-8,day-2),(9539,2,day-1,day+5);
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,end_week_number,matchup_type,home_member_id,away_member_id)
    VALUES(matchup,f.league_id,f.season_id,1,2,'playoff_final',f.member_ids[1],f.member_ids[2]);
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  result:=public.view_home(f.league_id,f.member_ids[1],jsonb_build_object('matchupId',matchup,'date',day));
  PERFORM pg_temp.check_rules(result->>'selectedDate'=day::text,'requested date remains within the second matchup week');
  PERFORM pg_temp.check_rules(result->'context'->>'weekNumber'='2','requested date chooses the second week');
  result:=public.view_home(f.league_id,f.member_ids[1],jsonb_build_object('matchupId',matchup,'date',day,'weekNumber',1));
  PERFORM pg_temp.check_rules(result->'context'->>'weekNumber'='1','explicit week selection takes precedence');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;

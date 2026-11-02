BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='home-change-version';
\ir rules-support.sql
DO $$
DECLARE f record; matchup uuid:=gen_random_uuid(); full_view jsonb; patch jsonb; expected bigint;
  day date:=(now() AT TIME ZONE 'America/Los_Angeles')::date;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9528);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9528,1,day,day+6);
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(matchup,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2]);
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  UPDATE private.screen_refresh_queue SET version=900 WHERE league_season_id=f.season_id;
  SELECT version INTO expected FROM public.league_versions WHERE league_id=f.league_id;
  full_view:=public.view_home(f.league_id,f.member_ids[1],jsonb_build_object('matchupId',matchup,'compact',true));
  patch:=public.view_home(f.league_id,f.member_ids[1],jsonb_build_object('matchupId',matchup,'compact',true,'section','forecast'));
  PERFORM pg_temp.check_rules(full_view->'context'->>'version'=expected::text,'Home uses the league change clock instead of the publication clock');
  PERFORM pg_temp.check_rules(patch->'context'->>'version'=expected::text,'forecast patches match the broadcast change clock');
  UPDATE private.screen_refresh_queue SET version=0 WHERE league_season_id=f.season_id;
  patch:=public.view_home(f.league_id,f.member_ids[1],jsonb_build_object('matchupId',matchup,'compact',true,'section','forecast'));
  PERFORM pg_temp.check_rules(patch->'context'->>'version'=expected::text,'a lagging publication clock cannot regress the patch version');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;

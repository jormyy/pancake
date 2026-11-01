\set ON_ERROR_STOP on
\set expected_db_port 58022
\getenv expected_db_port PANCAKE_TEST_DB_PORT
SELECT :'HOST' IN ('127.0.0.1','localhost') AND :'PORT' = :'expected_db_port' AS local_target \gset
\if :local_target
\else
  DO $$ BEGIN RAISE EXCEPTION 'Use the private local database.'; END $$;
\endif
BEGIN;
\ir rules-support.sql
DO $$
DECLARE fixture record; player uuid:=gen_random_uuid(); claim uuid; clears timestamptz; day date;
BEGIN
  SELECT * INTO fixture FROM pg_temp.rules_fixture(2,9541,'active');
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,status,nba_team)
    VALUES(player,'Timezone','Change','PG',ARRAY['PG'],'Active','SIM');
  INSERT INTO public.waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at)
    VALUES(fixture.league_id,fixture.season_id,player,'2026-10-30 07:00Z');
  claim:=public.create_waiver_claim_atomic(fixture.league_id,fixture.member_ids[1],player,NULL,fixture.user_ids[1],0);
  UPDATE public.waiver_claims SET submitted_at='2026-11-01 14:00Z' WHERE id=claim;
  PERFORM set_config('request.jwt.claim.sub',fixture.user_ids[1]::text,true);
  PERFORM public.update_league_settings_atomic(fixture.league_id,'{"timezone":"Asia/Tokyo"}');
  SELECT clears_at INTO clears FROM public.waiver_wire_log WHERE league_id=fixture.league_id AND player_id=player;
  SELECT process_date INTO day FROM public.waiver_claims WHERE id=claim;
  PERFORM pg_temp.check_rules(clears='2026-11-01 15:00Z'::timestamptz,'Changing timezone moves the hold to Tokyo midnight');
  PERFORM pg_temp.check_rules(day='2026-11-02','Changing timezone reschedules the pending claim');
  PERFORM pg_temp.check_rules((day::timestamp AT TIME ZONE 'Asia/Tokyo')>=clears,'The pending claim cannot run before its hold');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;

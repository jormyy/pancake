BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE taxi_read_fixture AS SELECT * FROM pg_temp.rules_fixture(2,9548);
CREATE TEMP TABLE taxi_read_other AS SELECT * FROM pg_temp.rules_fixture(1,9548);
GRANT SELECT ON taxi_read_fixture,taxi_read_other TO authenticated;
DO $$
DECLARE f record; player uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO f FROM taxi_read_fixture;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games,nba_team)
    VALUES(player,'Search','Career','PG',ARRAY['PG'],1,64,'BOS');
  INSERT INTO league_member_taxi_exits(league_id,member_id,player_id) VALUES(f.league_id,f.member_ids[1],player);
  PERFORM pg_temp.check_rules((SELECT career_regular_season_games=64 FROM public.search_players(p_query=>'Search Career',p_league_id=>f.league_id,p_limit=>20,p_offset=>0) WHERE id=player),'search appends career regular-season games');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
END;
$$;
SET LOCAL ROLE authenticated;
SELECT pg_temp.check_rules((SELECT count(*)=1 FROM league_member_taxi_exits WHERE league_id=(SELECT league_id FROM taxi_read_fixture)),'member reads team taxi exits');
SELECT set_config('request.jwt.claim.sub',(SELECT user_ids[1]::text FROM taxi_read_other),true);
SELECT pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM league_member_taxi_exits WHERE league_id=(SELECT league_id FROM taxi_read_fixture)),'outsider cannot read league taxi exits');
RESET ROLE;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;

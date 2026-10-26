BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; player uuid:=gen_random_uuid(); target uuid:=gen_random_uuid(); code text; claim uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9551);
  UPDATE leagues SET taxi_slots=1 WHERE id=f.league_id;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games)
    VALUES(player,'Known','Taxi','PG',ARRAY['PG'],1,64),(target,'Free','Agent','PG',ARRAY['PG'],3,100);
  PERFORM private.authorize_taxi_acquisition(f.league_id,f.season_id,f.member_ids[1],player,'draft',gen_random_uuid());
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,is_on_taxi,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],player,true,'draft');
  UPDATE players SET career_regular_season_games=NULL WHERE id=player;
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_problems(f.league_id,f.season_id,f.member_ids[1])),'unknown count keeps an existing taxi roster legal');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  claim:=public.create_waiver_claim_atomic(f.league_id,f.member_ids[1],target,NULL,f.user_ids[1]);
  UPDATE waiver_claims SET process_date=(now() AT TIME ZONE 'America/New_York')::date-1 WHERE id=claim;
  PERFORM public.process_next_waiver_claim_atomic((now() AT TIME ZONE 'America/New_York')::date);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM roster_players WHERE league_id=f.league_id AND player_id=target),'unknown taxi count permits an active award');
  UPDATE players SET career_regular_season_games=65 WHERE id=player;
  BEGIN PERFORM private.assert_legal_roster(f.league_id,f.season_id,f.member_ids[1]); EXCEPTION WHEN OTHERS THEN code:=SQLSTATE; END;
  PERFORM pg_temp.check_rules(code='PA009','known ineligible count blocks acquisitions with PA009');
  UPDATE players SET years_exp=0 WHERE id=player;
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_problems(f.league_id,f.season_id,f.member_ids[1])),'rookies stay eligible regardless of career games');
  PERFORM pg_temp.check_rules(private.taxi_player_eligible(gen_random_uuid(),player),'taxi eligibility depends only on the player');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;

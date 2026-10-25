BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; player uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9540);
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games)
    VALUES(player,'Taxi','Boundary','PG',ARRAY['PG'],1,64);
  UPDATE leagues SET taxi_rule='drafted_rookies' WHERE id=f.league_id;
  PERFORM pg_temp.check_rules(private.taxi_player_eligible(f.league_id,player),'64 games qualifies under every stored league rule');
  UPDATE players SET career_regular_season_games=65 WHERE id=player;
  PERFORM pg_temp.check_rules(NOT private.taxi_player_eligible(f.league_id,player),'65 games is ineligible');
  UPDATE players SET career_regular_season_games=NULL WHERE id=player;
  PERFORM pg_temp.check_rules(NOT private.taxi_player_eligible(f.league_id,player),'unknown games does not qualify a veteran');
  UPDATE players SET years_exp=0 WHERE id=player;
  PERFORM pg_temp.check_rules(private.taxi_player_eligible(f.league_id,player),'rookie qualifies with unknown games');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM public.update_league_settings_atomic(p_league_id=>f.league_id,p_settings=>'{"taxi_rule":"drafted_rookies"}');
  PERFORM pg_temp.check_rules((SELECT taxi_rule='rookies_or_64_games' FROM leagues WHERE id=f.league_id),'settings ignores the old taxi rule');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;

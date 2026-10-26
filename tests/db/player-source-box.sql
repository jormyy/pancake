BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE v_id uuid:=gen_random_uuid(); v_game uuid:=gen_random_uuid(); v_result jsonb;
BEGIN
  INSERT INTO players(id,first_name,last_name,nba_team) VALUES(v_id,'Box','Identity','SAS');
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(v_game,'002sourcebox',2027,1,'2026-10-25','SAS','MIN','Final');
  v_result:=resolve_player_imports_atomic(p_source=>'nba_cdn',p_records=>jsonb_build_array(jsonb_build_object(
    'provider_id','source-box-player','display_name','Box-Identity','nba_game_id','002sourcebox','nba_team','SA','metadata',jsonb_build_object('position','C'))));
  IF (v_result->'results'->0->>'player_id')::uuid IS DISTINCT FROM v_id OR NOT EXISTS(
    SELECT FROM players WHERE id=v_id AND nba_id='source-box-player' AND position='C') THEN
    RAISE EXCEPTION 'Box identity or missing position is not linked in the same import';
  END IF;
END $$;
ROLLBACK;
SELECT 'source box: 1 check PASS';

BEGIN;
DO $$
DECLARE
  v_player uuid := gen_random_uuid(); v_old uuid := gen_random_uuid(); v_known uuid := gen_random_uuid(); v_g uuid; v_id text; v_i int;
BEGIN
  INSERT INTO players(id,first_name,last_name,years_exp) VALUES(v_player,'Regular','Fixture',0),(v_old,'Threshold','Veteran',10);
  PERFORM complete_player_career_base_atomic(p_player_id=>v_player,p_espn_id=>'',p_nba_id=>'',p_season_year=>2027);
  INSERT INTO players(id,first_name,last_name,years_exp,career_regular_season_games) VALUES(v_known,'Known','Veteran',10,331);
  FOR v_i IN 1..7 LOOP
    v_g:=gen_random_uuid();
    v_id:=CASE v_i WHEN 1 THEN '0022600904' WHEN 2 THEN '0012600904' WHEN 3 THEN '0042600904'
      WHEN 4 THEN '0052600904' WHEN 5 THEN '0062600904' WHEN 6 THEN '0022600905' ELSE '0022600906' END;
    INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
      VALUES(v_g,v_id,2027,1,DATE '2026-10-25'+v_i,'BOS','MIN','Final');
    INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,minutes_played,did_not_play)
      VALUES(v_player,v_g,2027,1,CASE WHEN v_i=6 THEN 0 ELSE 12 END,v_i=7);
  END LOOP;
  IF (SELECT career_regular_season_games FROM players WHERE id=v_player) <> 2 THEN RAISE EXCEPTION 'Regular-season appearance predicate is incorrect'; END IF;
  v_g:=gen_random_uuid();
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(v_g,'0022000900',2021,1,'2020-12-21','BOS','MIN','Final');
  INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,minutes_played,did_not_play)
    VALUES(v_player,v_g,2021,1,12,false);
  IF (SELECT career_regular_season_games FROM players WHERE id=v_player) <> 2 THEN RAISE EXCEPTION 'Pre-coverage game counted'; END IF;
  FOR v_i IN 1..65 LOOP
    v_g:=gen_random_uuid();
    INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
      VALUES(v_g,'00226'||lpad((8000+v_i)::text,5,'0'),2027,1,DATE '2026-10-25'+v_i,'BOS','MIN','Final');
    INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,minutes_played,did_not_play)
      VALUES(v_old,v_g,2027,1,12,false),(v_known,v_g,2027,1,12,false);
  END LOOP;
  IF (SELECT career_regular_season_games FROM players WHERE id=v_old) IS NOT NULL THEN RAISE EXCEPTION 'Unbased player is recounted automatically'; END IF;
  IF NOT complete_player_career_base_atomic(p_player_id=>v_old,p_espn_id=>'',p_nba_id=>'',p_season_year=>2027) THEN RAISE EXCEPTION '65-game fallback is refused'; END IF;
  IF NOT EXISTS(SELECT FROM players WHERE id=v_old AND career_regular_season_games=65 AND career_games_base=0
    AND career_games_base_season=2020 AND career_games_base_source='threshold') THEN RAISE EXCEPTION '65-game lower bound is wrong'; END IF;
  IF complete_player_career_base_atomic(p_player_id=>v_known,p_espn_id=>'',p_nba_id=>'',p_season_year=>2027)
    OR (SELECT career_regular_season_games FROM players WHERE id=v_known)<>331 THEN RAISE EXCEPTION 'Lower-bound fallback replaces a larger known count'; END IF;
  IF claim_player_career_base_atomic(v_old,now()) THEN RAISE EXCEPTION 'Known base triggers another lookup'; END IF;
  UPDATE nba_games SET nba_game_id='0062600999' WHERE nba_game_id='0022600904';
  IF (SELECT career_regular_season_games FROM players WHERE id=v_player) <> 1 THEN RAISE EXCEPTION 'Game-type correction does not recount'; END IF;
END $$;
ROLLBACK;
SELECT 'player data regular season: game types, DNP, zero minutes and threshold PASS';

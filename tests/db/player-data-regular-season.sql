BEGIN;
DO $$
DECLARE
  v_player uuid := gen_random_uuid(); v_old uuid := gen_random_uuid(); v_g uuid; v_id text; v_i int;
BEGIN
  INSERT INTO players(id,first_name,last_name,years_exp) VALUES(v_player,'Regular','Fixture',1),(v_old,'Threshold','Veteran',10);
  FOR v_i IN 1..7 LOOP
    v_g:=gen_random_uuid();
    v_id:=CASE v_i WHEN 1 THEN '0022600904' WHEN 2 THEN '0012600904' WHEN 3 THEN '0042600904'
      WHEN 4 THEN '0052600904' WHEN 5 THEN '0062600904' WHEN 6 THEN '0022600905' ELSE '0022600906' END;
    INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
      VALUES(v_g,v_id,2027,1,DATE '2026-10-25'+v_i,'BOS','MIN','Final');
    INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,minutes_played,did_not_play)
      VALUES(v_player,v_g,2027,1,CASE WHEN v_i=6 THEN 0 ELSE 12 END,v_i=7);
  END LOOP;
  IF (SELECT career_regular_season_games FROM players WHERE id=v_player) <> 1 THEN RAISE EXCEPTION 'Non-regular, zero-minute, or DNP game counted'; END IF;
  v_g:=gen_random_uuid();
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(v_g,'0022000900',2021,1,'2020-12-21','BOS','MIN','Final');
  INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,minutes_played,did_not_play)
    VALUES(v_player,v_g,2021,1,12,false);
  IF (SELECT career_regular_season_games FROM players WHERE id=v_player) <> 1 THEN RAISE EXCEPTION 'Pre-coverage game counted'; END IF;
  FOR v_i IN 1..65 LOOP
    v_g:=gen_random_uuid();
    INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
      VALUES(v_g,'00226'||lpad((8000+v_i)::text,5,'0'),2027,1,DATE '2026-10-25'+v_i,'BOS','MIN','Final');
    INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,minutes_played,did_not_play)
      VALUES(v_old,v_g,2027,1,12,false);
  END LOOP;
  IF NOT EXISTS(SELECT FROM players WHERE id=v_old AND career_regular_season_games=65 AND career_games_prior IS NULL) THEN
    RAISE EXCEPTION 'Veteran needs an outside lookup despite 65 observed games';
  END IF;
  IF claim_player_career_prior_atomic(v_old,now()) THEN RAISE EXCEPTION '65-game veteran triggers a prior lookup'; END IF;
  UPDATE players SET career_regular_season_games=NULL WHERE id IN(v_player,v_old);
  PERFORM private.recount_player_career_games(ARRAY(SELECT id FROM players));
  IF NOT EXISTS(SELECT FROM players WHERE id=v_old AND career_regular_season_games=65)
    OR NOT EXISTS(SELECT FROM players WHERE id=v_player AND career_regular_season_games=1) THEN
    RAISE EXCEPTION 'Migration backfill leaves reconstructable counts unknown';
  END IF;
  UPDATE nba_games SET nba_game_id='0062600999' WHERE nba_game_id='0022600904';
  IF (SELECT career_regular_season_games FROM players WHERE id=v_player) <> 0 THEN RAISE EXCEPTION 'Game-type correction does not recount'; END IF;
END $$;
ROLLBACK;
SELECT 'player data regular season: game types, DNP, zero minutes and threshold PASS';

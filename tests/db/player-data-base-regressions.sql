BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  v_player uuid := gen_random_uuid(); v_game uuid := gen_random_uuid();
BEGIN
  INSERT INTO players(id,first_name,last_name,years_exp,career_regular_season_games)
    VALUES(v_player,'Mario','Hezonja',6,331);
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(v_game,'0022000975',2021,1,'2020-12-25','POR','LAL','Final');
  INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,minutes_played,did_not_play)
    VALUES(v_player,v_game,2021,1,12,false);
  IF (SELECT career_regular_season_games FROM players WHERE id=v_player) <> 331 THEN
    RAISE EXCEPTION 'Returning veteran loses his existing ESPN count before a base is fetched';
  END IF;
END $$;
ROLLBACK;
BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  v_player uuid := gen_random_uuid(); v_game uuid := gen_random_uuid();
BEGIN
  INSERT INTO players(id,first_name,last_name,years_exp,career_regular_season_games)
    VALUES(v_player,'Cam','Christie',2,69);
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(v_game,'0022500975',2026,1,'2025-12-25','LAC','LAL','Final');
  INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,minutes_played,did_not_play)
    SELECT v_player,v_game,2026,1,12,false;
  IF (SELECT career_regular_season_games FROM players WHERE id=v_player) <> 69 THEN
    RAISE EXCEPTION 'A hole in local boxes replaces a known career total';
  END IF;
END $$;
ROLLBACK;
SELECT 'returning veteran and incomplete coverage transition: 2 cases PASS';

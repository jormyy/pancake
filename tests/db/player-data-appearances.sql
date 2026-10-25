BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  v_player uuid := gen_random_uuid(); v_game uuid := gen_random_uuid(); v_column text;
BEGIN
  INSERT INTO players(id,first_name,last_name,years_exp) VALUES(v_player,'Appearance','Fixture',0);
  PERFORM complete_player_career_base_atomic(p_player_id=>v_player,p_espn_id=>'',p_nba_id=>'',p_season_year=>2027);
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(v_game,'0022600976',2027,1,'2026-10-25','BOS','LAL','Final');
  INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,minutes_played,did_not_play)
    VALUES(v_player,v_game,2027,1,0,true);
  FOREACH v_column IN ARRAY ARRAY['minutes_played','points','rebounds','offensive_rebounds','defensive_rebounds',
    'assists','steals','blocks','turnovers','personal_fouls','field_goals_made','field_goals_attempted',
    'three_pointers_made','three_pointers_attempted','free_throws_made','free_throws_attempted'] LOOP
    EXECUTE format('UPDATE player_game_stats SET %I=1 WHERE player_id=$1',v_column) USING v_player;
    IF (SELECT career_regular_season_games FROM players WHERE id=v_player)<>1 THEN RAISE EXCEPTION 'Appearance ignores positive %',v_column; END IF;
    EXECUTE format('UPDATE player_game_stats SET %I=0 WHERE player_id=$1',v_column) USING v_player;
    IF (SELECT career_regular_season_games FROM players WHERE id=v_player)<>0 THEN RAISE EXCEPTION 'Correction keeps an empty % appearance',v_column; END IF;
  END LOOP;
  UPDATE player_game_stats SET plus_minus=5,did_not_play=false WHERE player_id=v_player;
  IF (SELECT career_regular_season_games FROM players WHERE id=v_player)<>0 THEN RAISE EXCEPTION 'DNP flag or plus-minus fabricates an appearance'; END IF;
END $$;
ROLLBACK;
SELECT 'all 16 appearance fields, corrections, plus-minus and DNP flag: PASS';

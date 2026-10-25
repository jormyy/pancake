BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  v_player uuid := gen_random_uuid(); v_game uuid := gen_random_uuid(); v_stats jsonb;
BEGIN
  INSERT INTO players(id,first_name,last_name,years_exp) VALUES(v_player,'Career','Fixture',0);
  PERFORM complete_player_career_base_atomic(p_player_id=>v_player,p_espn_id=>'',p_nba_id=>'',p_season_year=>2027);
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(v_game,'0022600902',2027,1,'2026-10-25','BOS','MIN','Scheduled');
  v_stats := jsonb_build_array(jsonb_build_object('player_id',v_player,'game_id',v_game,'minutes_played',12,'did_not_play',false));
  PERFORM save_live_game_stats_atomic(p_game_id=>v_game,p_provider_game_id=>'0022600902',p_stats=>v_stats,p_elapsed_seconds=>720);
  IF (SELECT career_regular_season_games FROM players WHERE id=v_player) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Live save does not recount played regular-season games';
  END IF;
  PERFORM save_live_game_stats_atomic(v_game,'0022600902',v_stats,720);
  IF (SELECT career_regular_season_games FROM players WHERE id=v_player) <> 1 THEN RAISE EXCEPTION 'Replay double counts'; END IF;
  PERFORM save_game_stats_atomic(p_game_id=>v_game,p_provider_game_id=>'0022600902',p_stats=>jsonb_set(v_stats,'{0,minutes_played}','0'),p_is_final=>true);
  IF (SELECT career_regular_season_games FROM players WHERE id=v_player) <> 0 THEN RAISE EXCEPTION 'Correction does not recount'; END IF;
  PERFORM save_game_stats_atomic(v_game,'0022600902',v_stats,true);
  IF (SELECT career_regular_season_games FROM players WHERE id=v_player) <> 1 THEN RAISE EXCEPTION 'Final correction does not recount'; END IF;
END $$;
ROLLBACK;
SELECT 'player data career: save, replay and corrections PASS';

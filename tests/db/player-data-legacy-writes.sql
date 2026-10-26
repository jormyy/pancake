BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  v_unbased uuid:=gen_random_uuid(); v_based uuid:=gen_random_uuid(); v_game uuid:=gen_random_uuid();
  v_at timestamptz:='2026-10-25T16:00:00Z';
BEGIN
  INSERT INTO players(id,first_name,last_name,career_regular_season_games)
    VALUES(v_unbased,'Legacy','Unbased',65);
  UPDATE players SET career_regular_season_games=64 WHERE id=v_unbased;
  IF (SELECT career_regular_season_games FROM players WHERE id=v_unbased) IS DISTINCT FROM 64 THEN
    RAISE EXCEPTION 'An explicit unbased count correction is discarded';
  END IF;
  UPDATE players SET career_regular_season_games=NULL WHERE id=v_unbased;
  IF (SELECT career_regular_season_games FROM players WHERE id=v_unbased) IS NOT NULL THEN
    RAISE EXCEPTION 'An explicit unknown count is discarded';
  END IF;
  INSERT INTO players(id,first_name,last_name,career_games_base,career_games_base_season,
    career_games_base_source,career_games_base_checked_at,career_regular_season_games)
    VALUES(v_based,'Legacy','Based',20,2026,'espn',v_at,23);
  IF (SELECT career_regular_season_games FROM players WHERE id=v_based) IS DISTINCT FROM 23 THEN
    RAISE EXCEPTION 'An explicit inserted count is discarded';
  END IF;
  UPDATE players SET career_regular_season_games=22,career_games_checked_at=v_at WHERE id=v_based;
  IF (SELECT career_regular_season_games FROM players WHERE id=v_based) IS DISTINCT FROM 22 THEN
    RAISE EXCEPTION 'The deployed Edge count write is discarded';
  END IF;
  UPDATE players SET career_games_checked_at=v_at+interval '1 day' WHERE id=v_based;
  IF (SELECT career_regular_season_games FROM players WHERE id=v_based) IS DISTINCT FROM 22 THEN
    RAISE EXCEPTION 'A timestamp-only write recounts the player';
  END IF;
  UPDATE players SET career_regular_season_games=NULL WHERE id=v_based;
  IF (SELECT career_regular_season_games FROM players WHERE id=v_based) IS NOT NULL THEN
    RAISE EXCEPTION 'An explicit based unknown count is discarded';
  END IF;
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(v_game,'0022600918',2027,1,'2026-10-25','BOS','MIN','Final');
  PERFORM save_game_stats_atomic(p_game_id=>v_game,p_provider_game_id=>'0022600918',
    p_stats=>jsonb_build_array(jsonb_build_object('player_id',v_based,'game_id',v_game,'minutes_played',12,'did_not_play',false)),p_is_final=>true);
  IF (SELECT career_regular_season_games FROM players WHERE id=v_based) IS DISTINCT FROM 21 THEN
    RAISE EXCEPTION 'A stats save no longer recounts a based player';
  END IF;
  UPDATE players SET career_regular_season_games=70 WHERE id=v_based;
  UPDATE player_game_stats SET minutes_played=0 WHERE player_id=v_based AND game_id=v_game;
  IF (SELECT career_regular_season_games FROM players WHERE id=v_based) IS DISTINCT FROM 70 THEN
    RAISE EXCEPTION 'An automatic recount lowers a known 65-plus count';
  END IF;
  UPDATE players SET career_regular_season_games=19 WHERE id=v_based;
  IF (SELECT career_regular_season_games FROM players WHERE id=v_based) IS DISTINCT FROM 19 THEN
    RAISE EXCEPTION 'An explicit based count correction is discarded';
  END IF;
  UPDATE players SET career_games_base=21 WHERE id=v_based;
  IF (SELECT career_regular_season_games FROM players WHERE id=v_based) IS DISTINCT FROM 21 THEN
    RAISE EXCEPTION 'A base change no longer recounts the player';
  END IF;
END $$;
ROLLBACK;
SELECT 'player data legacy writes: 10 checks PASS';

BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  v_low uuid:=gen_random_uuid(); v_at_limit uuid:=gen_random_uuid(); v_veteran uuid:=gen_random_uuid();
  v_coverage uuid:=gen_random_uuid(); v_espn uuid:=gen_random_uuid(); v_game uuid; v_first_game uuid;
  v_at timestamptz:='2026-10-25T16:00:00Z'; v_i integer;
BEGIN
  INSERT INTO players(id,first_name,last_name,career_regular_season_games) VALUES
    (v_low,'Queue','Below',64),(v_at_limit,'Queue','Limit',65),(v_veteran,'Queue','Veteran',331);
  INSERT INTO players(id,first_name,last_name,career_games_base,career_games_base_season,
    career_games_base_source,career_games_base_checked_at) VALUES
    (v_coverage,'Queue','Coverage',0,2020,'coverage',v_at),
    (v_espn,'Queue','ESPN',1,2026,'espn',v_at);
  IF NOT claim_player_career_base_atomic(p_player_id=>v_low,p_now=>v_at) THEN
    RAISE EXCEPTION 'A 64-game player is not queued';
  END IF;
  IF claim_player_career_base_atomic(p_player_id=>v_at_limit,p_now=>v_at)
    OR claim_player_career_base_atomic(p_player_id=>v_veteran,p_now=>v_at) THEN
    RAISE EXCEPTION 'A known 65-plus player is queued';
  END IF;
  IF claim_player_career_base_atomic(p_player_id=>v_espn,p_now=>v_at) THEN
    RAISE EXCEPTION 'An ESPN base is fetched again';
  END IF;
  FOR v_i IN 1..64 LOOP
    v_game:=gen_random_uuid();
    IF v_i=1 THEN v_first_game:=v_game; END IF;
    INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
      VALUES(v_game,'00226'||lpad((8500+v_i)::text,5,'0'),2027,1,DATE '2026-10-25'+v_i,'BOS','MIN','Final');
    INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,minutes_played)
      VALUES(v_coverage,v_game,2027,1,12);
  END LOOP;
  IF NOT claim_player_career_base_atomic(p_player_id=>v_coverage,p_now=>v_at) THEN
    RAISE EXCEPTION 'A 64-game coverage base is not queued';
  END IF;
  v_game:=gen_random_uuid();
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(v_game,'0022608565',2027,1,'2026-12-31','BOS','MIN','Final');
  INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,minutes_played)
    VALUES(v_coverage,v_game,2027,1,12);
  IF claim_player_career_base_atomic(p_player_id=>v_coverage,p_now=>v_at+interval '7 days') THEN
    RAISE EXCEPTION 'A player reaching 65 before the next claim is fetched';
  END IF;
  UPDATE player_game_stats SET minutes_played=12 WHERE player_id=v_coverage AND game_id=v_game;
  IF (SELECT career_regular_season_games FROM players WHERE id=v_coverage)<>65 THEN
    RAISE EXCEPTION 'Re-saving 65 appearances changes the count';
  END IF;
  UPDATE player_game_stats SET minutes_played=0 WHERE player_id=v_coverage AND game_id=v_first_game;
  IF (SELECT career_regular_season_games FROM players WHERE id=v_coverage)<>65
    OR claim_player_career_base_atomic(p_player_id=>v_coverage,p_now=>v_at+interval '14 days') THEN
    RAISE EXCEPTION 'A correction queues a player already known to have 65 games';
  END IF;
  IF NOT EXISTS(SELECT FROM players WHERE id=v_at_limit AND career_regular_season_games=65 AND career_games_base_attempted_at IS NULL)
    OR NOT EXISTS(SELECT FROM players WHERE id=v_veteran AND career_regular_season_games=331 AND career_games_base_attempted_at IS NULL) THEN
    RAISE EXCEPTION 'Skipping a known player changes stored count or attempt time';
  END IF;
END $$;
ROLLBACK;
SELECT 'player data career queue: 8 checks PASS';

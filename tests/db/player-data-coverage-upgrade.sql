BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  v_player uuid:=gen_random_uuid(); v_lower uuid:=gen_random_uuid(); v_legacy uuid:=gen_random_uuid();
  v_game uuid; v_i integer; v_at timestamptz:='2026-10-25T16:00:00Z';
BEGIN
  INSERT INTO players(id,first_name,last_name,years_exp,espn_id,nba_id) VALUES
    (v_player,'Coverage','Upgrade',1,'coverage-upgrade','coverage-nba'),
    (v_lower,'Coverage','Preserved',1,'coverage-preserved',NULL);
  INSERT INTO players(id,first_name,last_name,years_exp,espn_id,career_regular_season_games)
    VALUES(v_legacy,'Legacy','Preserved',4,'legacy-preserved',100);
  FOR v_i IN 1..64 LOOP
    v_game:=gen_random_uuid();
    INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
      VALUES(v_game,CASE WHEN v_i=64 THEN '00226' ELSE '00225' END||lpad((9500+v_i)::text,5,'0'),
        CASE WHEN v_i=64 THEN 2027 ELSE 2026 END,
        1,CASE WHEN v_i=64 THEN DATE '2026-10-25' ELSE DATE '2025-12-01'+v_i END,'BOS','MIN','Final');
    INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,minutes_played,did_not_play)
      SELECT player_id,v_game,CASE WHEN v_i=64 THEN 2027 ELSE 2026 END,1,12,true
      FROM unnest(ARRAY[v_player,v_lower]) player_id;
  END LOOP;
  IF NOT complete_player_career_base_atomic(p_player_id=>v_player,p_espn_id=>'coverage-upgrade',p_nba_id=>'coverage-nba',p_season_year=>2027)
    OR NOT complete_player_career_base_atomic(p_player_id=>v_lower,p_espn_id=>'coverage-preserved',p_nba_id=>'',p_season_year=>2027) THEN
    RAISE EXCEPTION 'Coverage fixtures have no base';
  END IF;
  IF NOT EXISTS(SELECT FROM players WHERE id=v_player AND career_regular_season_games=64 AND career_games_base_source='coverage') THEN
    RAISE EXCEPTION 'Coverage fixture does not expose the missing historical games';
  END IF;
  IF NOT claim_player_career_base_atomic(p_player_id=>v_player,p_now=>v_at) THEN
    RAISE EXCEPTION 'Coverage base never gets its ESPN lookup';
  END IF;
  IF claim_player_career_base_atomic(p_player_id=>v_player,p_now=>v_at+interval '6 days') THEN
    RAISE EXCEPTION 'Coverage base retries before a week';
  END IF;
  IF complete_player_career_base_atomic(p_player_id=>v_player,p_espn_id=>'coverage-upgrade',p_nba_id=>'coverage-nba',p_season_year=>2027)
    OR NOT EXISTS(SELECT FROM players WHERE id=v_player AND career_regular_season_games=64
      AND career_games_base=0 AND career_games_base_season=2020 AND career_games_base_source='coverage') THEN
    RAISE EXCEPTION 'Unavailable ESPN history discards coverage';
  END IF;
  IF NOT claim_player_career_base_atomic(p_player_id=>v_player,p_now=>v_at+interval '7 days') THEN
    RAISE EXCEPTION 'Coverage failure never retries';
  END IF;
  IF complete_player_career_base_atomic(p_player_id=>v_player,p_base=>68,p_base_season=>2026,
    p_espn_id=>'wrong',p_nba_id=>'coverage-nba',p_season_year=>2027) THEN
    RAISE EXCEPTION 'Coverage upgrade accepts a changed identity';
  END IF;
  IF NOT complete_player_career_base_atomic(p_player_id=>v_player,p_base=>68,p_base_season=>2026,
    p_espn_id=>'coverage-upgrade',p_nba_id=>'coverage-nba',p_season_year=>2027) THEN
    RAISE EXCEPTION 'Coverage base cannot upgrade to ESPN';
  END IF;
  IF NOT EXISTS(SELECT FROM players WHERE id=v_player AND career_regular_season_games=69
    AND career_games_base=68 AND career_games_base_season=2026 AND career_games_base_source='espn'
    AND career_games_base_checked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Historical holes leave a 69-game player below 65';
  END IF;
  IF claim_player_career_base_atomic(p_player_id=>v_player,p_now=>v_at+interval '1 year')
    OR complete_player_career_base_atomic(p_player_id=>v_player,p_base=>99,p_base_season=>2026,
      p_espn_id=>'coverage-upgrade',p_nba_id=>'coverage-nba',p_season_year=>2027) THEN
    RAISE EXCEPTION 'Successful ESPN base is fetched or replaced again';
  END IF;
  IF complete_player_career_base_atomic(p_player_id=>v_lower,p_base=>60,p_base_season=>2026,
    p_espn_id=>'coverage-preserved',p_nba_id=>'',p_season_year=>2027)
    OR NOT EXISTS(SELECT FROM players WHERE id=v_lower AND career_regular_season_games=64 AND career_games_base_source='coverage') THEN
    RAISE EXCEPTION 'ESPN upgrade lowers the coverage count';
  END IF;
  IF complete_player_career_base_atomic(p_player_id=>v_legacy,p_base=>90,p_base_season=>2026,
    p_espn_id=>'legacy-preserved',p_nba_id=>'',p_season_year=>2027)
    OR NOT EXISTS(SELECT FROM players WHERE id=v_legacy AND career_regular_season_games=100 AND career_games_base IS NULL) THEN
    RAISE EXCEPTION 'ESPN base lowers a legacy count';
  END IF;
END $$;
ROLLBACK;
SELECT 'player data coverage upgrade: 12 checks PASS';

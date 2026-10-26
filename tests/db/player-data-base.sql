BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  v_player uuid := gen_random_uuid(); v_game uuid := gen_random_uuid(); v_loser uuid := gen_random_uuid();
  v_second uuid := gen_random_uuid(); v_rookie uuid := gen_random_uuid(); v_at timestamptz := '2026-10-25T16:00:00Z'; v_stats jsonb;
BEGIN
  INSERT INTO players(id,first_name,last_name,years_exp,espn_id,nba_id)
    VALUES(v_player,'Base','Veteran',10,'data-base-espn','data-base-nba');
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(v_game,'0022600903',2027,1,'2026-10-25','BOS','MIN','Scheduled'),
      (v_second,'0022600913',2027,1,'2026-10-26','BOS','MIN','Final');
  v_stats:=jsonb_build_array(jsonb_build_object('player_id',v_player,'game_id',v_game,'minutes_played',12,'did_not_play',true));
  PERFORM save_game_stats_atomic(v_game,'0022600903',v_stats,true);
  IF (SELECT career_regular_season_games FROM players WHERE id=v_player) IS NOT NULL THEN RAISE EXCEPTION 'Unknown veteran gets an unverified total'; END IF;
  IF NOT claim_player_career_base_atomic(p_player_id=>v_player,p_now=>v_at) THEN RAISE EXCEPTION 'First base attempt refused'; END IF;
  IF claim_player_career_base_atomic(v_player,v_at+interval '6 days 23 hours 59 minutes 59 seconds') THEN RAISE EXCEPTION 'Base retries before one week'; END IF;
  IF NOT claim_player_career_base_atomic(v_player,v_at+interval '7 days') THEN RAISE EXCEPTION 'Base does not retry at one week'; END IF;
  IF complete_player_career_base_atomic(p_player_id=>v_player,p_base=>20,p_base_season=>2026,p_espn_id=>'wrong',p_nba_id=>'data-base-nba',p_season_year=>2027) THEN RAISE EXCEPTION 'Stale provider identity accepted'; END IF;
  IF complete_player_career_base_atomic(p_player_id=>v_player,p_espn_id=>'data-base-espn',p_nba_id=>'data-base-nba',p_season_year=>2027) THEN RAISE EXCEPTION 'Unknown veteran gets an unsupported fallback'; END IF;
  IF NOT complete_player_career_base_atomic(p_player_id=>v_player,p_base=>20,p_base_season=>2026,p_espn_id=>'data-base-espn',p_nba_id=>'data-base-nba',p_season_year=>2027) THEN RAISE EXCEPTION 'Base refused'; END IF;
  IF (SELECT career_regular_season_games FROM players WHERE id=v_player) <> 21 THEN RAISE EXCEPTION 'Base excludes a real DNP-marked appearance'; END IF;
  IF complete_player_career_base_atomic(v_player,'data-base-espn','data-base-nba',30,2026,2027) OR claim_player_career_base_atomic(v_player,v_at+interval '30 days') THEN
    RAISE EXCEPTION 'Successful base is fetched or added again';
  END IF;
  PERFORM save_game_stats_atomic(v_game,'0022600903',v_stats,true);
  IF (SELECT career_regular_season_games FROM players WHERE id=v_player) <> 21 THEN RAISE EXCEPTION 'Base double counts on re-save'; END IF;
  UPDATE players SET career_regular_season_games=19,career_games_checked_at=v_at WHERE id=v_player;
  IF (SELECT career_regular_season_games FROM players WHERE id=v_player) <> 19 THEN RAISE EXCEPTION 'Deployed daily Edge count write is discarded'; END IF;
  INSERT INTO players(id,first_name,last_name,years_exp,sleeper_id) VALUES(v_loser,'Base','Veteran',10,'data-base-sleeper');
  INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,minutes_played,points,did_not_play)
    VALUES(v_loser,v_second,2027,1,0,1,true);
  PERFORM merge_players(v_loser,v_player);
  IF NOT EXISTS(SELECT FROM players WHERE id=v_loser AND career_games_base=20 AND career_games_base_season=2026
    AND career_regular_season_games=22 AND espn_id='data-base-espn' AND nba_id='data-base-nba') THEN RAISE EXCEPTION 'Merge loses base or distinct appearances'; END IF;
  DELETE FROM player_game_stats WHERE player_id=v_loser;
  IF (SELECT career_regular_season_games FROM players WHERE id=v_loser) <> 20 THEN RAISE EXCEPTION 'Deletion does not recount'; END IF;
  INSERT INTO players(id,first_name,last_name,years_exp,career_regular_season_games) VALUES(v_rookie,'Known zero','Rookie',0,0);
  IF NOT complete_player_career_base_atomic(p_player_id=>v_rookie,p_espn_id=>'',p_nba_id=>'',p_season_year=>2027) THEN RAISE EXCEPTION 'Zero rookie fallback is refused after an unavailable ESPN response'; END IF;
  IF has_function_privilege('authenticated','public.claim_player_career_base_atomic(uuid,timestamptz)','EXECUTE')
    OR has_function_privilege('anon','public.complete_player_career_base_atomic(uuid,text,text,integer,integer,integer)','EXECUTE') THEN RAISE EXCEPTION 'Client can write base'; END IF;
END $$;
ROLLBACK;
SELECT 'player data base: 15 checks PASS';

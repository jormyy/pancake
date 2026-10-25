BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  v_player uuid := gen_random_uuid(); v_game uuid := gen_random_uuid(); v_loser uuid := gen_random_uuid();
  v_at timestamptz := '2026-10-25T16:00:00Z'; v_stats jsonb;
BEGIN
  INSERT INTO players(id,first_name,last_name,years_exp,espn_id,nba_id)
    VALUES(v_player,'Prior','Veteran',10,'data-prior-espn','data-prior-nba');
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(v_game,'0022600903',2027,1,'2026-10-25','BOS','MIN','Scheduled');
  v_stats:=jsonb_build_array(jsonb_build_object('player_id',v_player,'game_id',v_game,'minutes_played',12,'did_not_play',false));
  PERFORM save_game_stats_atomic(v_game,'0022600903',v_stats,true);
  IF (SELECT career_regular_season_games FROM players WHERE id=v_player) IS NOT NULL THEN RAISE EXCEPTION 'Unknown veteran prior becomes taxi eligible'; END IF;
  IF NOT claim_player_career_prior_atomic(p_player_id=>v_player,p_now=>v_at) THEN RAISE EXCEPTION 'First prior attempt refused'; END IF;
  IF claim_player_career_prior_atomic(v_player,v_at+interval '6 days 23 hours 59 minutes 59 seconds') THEN RAISE EXCEPTION 'Prior retries before one week'; END IF;
  IF NOT claim_player_career_prior_atomic(v_player,v_at+interval '7 days') THEN RAISE EXCEPTION 'Prior does not retry at one week'; END IF;
  IF complete_player_career_prior_atomic(p_player_id=>v_player,p_prior=>20,p_espn_id=>'wrong',p_nba_id=>'data-prior-nba') THEN RAISE EXCEPTION 'Stale provider identity accepted'; END IF;
  IF NOT complete_player_career_prior_atomic(p_player_id=>v_player,p_prior=>20,p_espn_id=>'data-prior-espn',p_nba_id=>'data-prior-nba') THEN RAISE EXCEPTION 'Prior refused'; END IF;
  IF (SELECT career_regular_season_games FROM players WHERE id=v_player) <> 21 THEN RAISE EXCEPTION 'Prior does not add to observed games'; END IF;
  IF complete_player_career_prior_atomic(v_player,30,'data-prior-espn','data-prior-nba') OR claim_player_career_prior_atomic(v_player,v_at+interval '30 days') THEN
    RAISE EXCEPTION 'Successful prior is looked up or added again';
  END IF;
  PERFORM save_game_stats_atomic(v_game,'0022600903',v_stats,true);
  IF (SELECT career_regular_season_games FROM players WHERE id=v_player) <> 21 THEN RAISE EXCEPTION 'Prior double counts on re-save'; END IF;
  UPDATE players SET career_regular_season_games=999,career_games_checked_at=v_at WHERE id=v_player;
  IF (SELECT career_regular_season_games FROM players WHERE id=v_player) <> 21 THEN RAISE EXCEPTION 'Deployed daily Edge overwrites the counter'; END IF;
  INSERT INTO players(id,first_name,last_name,years_exp,sleeper_id) VALUES(v_loser,'Prior','Veteran',10,'data-prior-sleeper');
  PERFORM merge_players(v_loser,v_player);
  IF NOT EXISTS(SELECT FROM players WHERE id=v_loser AND career_games_prior=20 AND career_regular_season_games=21
    AND espn_id='data-prior-espn' AND nba_id='data-prior-nba') THEN RAISE EXCEPTION 'Merge loses or double counts prior'; END IF;
  DELETE FROM player_game_stats WHERE player_id=v_loser;
  IF (SELECT career_regular_season_games FROM players WHERE id=v_loser) <> 20 THEN RAISE EXCEPTION 'Deletion does not recount'; END IF;
  IF has_function_privilege('authenticated','public.claim_player_career_prior_atomic(uuid,timestamptz)','EXECUTE')
    OR has_function_privilege('anon','public.complete_player_career_prior_atomic(uuid,integer,text,text)','EXECUTE') THEN RAISE EXCEPTION 'Client can write prior'; END IF;
END $$;
ROLLBACK;
SELECT 'player data prior: 10 cases PASS';

BEGIN;
DO $$
DECLARE
  v_player uuid := gen_random_uuid();
  v_old uuid := gen_random_uuid();
  v_new uuid := gen_random_uuid();
  v_day date := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  INSERT INTO players(id,first_name,last_name,nba_team)
  VALUES(v_player,'Luka','Dončić','DAL');
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
  VALUES(v_old,'identity-old-'||v_old::text,2094,1,v_day,'DAL','SAC','InProgress',now()-interval '1 hour'),
    (v_new,'identity-new-'||v_new::text,2094,1,v_day,'LAL','UTA','Scheduled',now()+interval '1 hour');
  INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,did_not_play)
  VALUES(v_player,v_new,2094,1,true);
  IF private.lineup_game_started(v_player,v_day) THEN
    RAISE EXCEPTION 'Stale NBA team locks the player to his former team game';
  END IF;
  IF private.roster_status_game_started(v_player) THEN
    RAISE EXCEPTION 'Stale NBA team locks roster status to the former team game';
  END IF;
  UPDATE nba_games SET status='Scheduled',game_time=now()+interval '2 hours' WHERE id=v_old;
  UPDATE nba_games SET status='InProgress',game_time=now()-interval '1 hour' WHERE id=v_new;
  IF NOT private.lineup_game_started(v_player,v_day) THEN
    RAISE EXCEPTION 'Observed new-team game fails to lock the lineup';
  END IF;
  IF NOT private.roster_status_game_started(v_player) THEN
    RAISE EXCEPTION 'Observed new-team game fails to lock roster status';
  END IF;
  DELETE FROM player_game_stats WHERE player_id=v_player;
  IF private.lineup_game_started(v_player,v_day) OR private.roster_status_game_started(v_player) THEN
    RAISE EXCEPTION 'A future old-team game locks without observed participation';
  END IF;
  UPDATE nba_games SET game_time=now()-interval '1 second' WHERE id=v_old;
  IF NOT private.lineup_game_started(v_player,v_day) OR NOT private.roster_status_game_started(v_player) THEN
    RAISE EXCEPTION 'Team fallback fails before participation arrives';
  END IF;
  RAISE NOTICE 'PASS SYNTHETIC trade clocks: observed team wins; future, started and fallback locks hold';
END $$;
ROLLBACK;

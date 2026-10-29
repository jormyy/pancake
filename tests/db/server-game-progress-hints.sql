BEGIN;
DO $$
DECLARE
  v_league uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_game uuid := gen_random_uuid();
  v_revision bigint;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data)
    VALUES(v_user,'authenticated','authenticated',v_user||'@example.test','{}','{}');
  INSERT INTO leagues(id,name,slug,commissioner_id,status)
    VALUES(v_league,'Game progress hints',v_league::text,v_user,'active');
  INSERT INTO league_seasons(league_id,season_year,is_current) VALUES(v_league,8994,true);
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,status,home_team,away_team)
    VALUES(v_game,'002review5501',8994,1,'2026-01-05','InProgress','BOS','NYK');
  SELECT revision INTO v_revision FROM league_change_hints WHERE league_id=v_league AND topic='game';
  IF v_revision IS NULL THEN RAISE EXCEPTION 'Game insertion does not emit a hint'; END IF;
  UPDATE nba_games SET live_stats_elapsed_seconds=30,live_scoreboard_elapsed_seconds=35 WHERE id=v_game;
  IF (SELECT revision FROM league_change_hints WHERE league_id=v_league AND topic='game') <> v_revision THEN
    RAISE EXCEPTION 'Internal game progress emits a client hint';
  END IF;
  UPDATE nba_games SET status='Final' WHERE id=v_game;
  IF NOT EXISTS(SELECT 1 FROM league_change_hints WHERE league_id=v_league AND topic='game'
    AND revision=v_revision AND scopes @> jsonb_build_array(jsonb_build_object('date','2026-01-05'))) THEN
    RAISE EXCEPTION 'A visible game change loses its coalesced hint';
  END IF;
END $$;
ROLLBACK;

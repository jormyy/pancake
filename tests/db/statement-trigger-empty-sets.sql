BEGIN;
SET LOCAL statement_timeout='60s';
\ir rules-support.sql
CREATE FUNCTION pg_temp.clear_signals() RETURNS void LANGUAGE sql AS $$
  DELETE FROM private.league_version_pending WHERE true;
  DELETE FROM public.league_change_hints WHERE true;
$$;
CREATE FUNCTION pg_temp.pending(p_league uuid) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM private.league_version_pending WHERE league_id=p_league
$$;
CREATE FUNCTION pg_temp.hints(p_league uuid,p_topic text) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.league_change_hints WHERE league_id=p_league AND topic=p_topic
$$;
DO $$
DECLARE fixture record; v_game uuid:=gen_random_uuid(); v_player uuid:=gen_random_uuid(); v_stat uuid;
BEGIN
  SELECT * INTO fixture FROM pg_temp.rules_fixture(1,9651,'active');
  INSERT INTO public.players(id,first_name,last_name) VALUES(v_player,'Empty','Set');
  INSERT INTO public.nba_games(id,nba_game_id,game_date,season_year,week_number,home_team,away_team,status,home_score,away_score)
    VALUES(v_game,'0029910651','2026-01-15',9651,1,'BOS','MIA','InProgress',10,8);
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,did_not_play)
    VALUES(v_player,v_game,9651,1,10,false) RETURNING id INTO v_stat;
  IF (SELECT points FROM analytics.player_season_totals WHERE player_id=v_player AND season_year=9651) IS DISTINCT FROM 10 THEN
    RAISE EXCEPTION 'FAIL: an inserted stat reaches the season totals';
  END IF;
  PERFORM pg_temp.clear_signals();
  UPDATE public.nba_games SET live_stats_elapsed_seconds=30 WHERE id=v_game;
  IF pg_temp.pending(fixture.league_id)<>0 OR pg_temp.hints(fixture.league_id,'game')<>0 THEN
    RAISE EXCEPTION 'FAIL: elapsed progress alone publishes a league change';
  END IF;
  UPDATE public.nba_games SET home_score=home_score+1 WHERE id=v_game;
  IF pg_temp.pending(fixture.league_id)<>1 OR pg_temp.hints(fixture.league_id,'game')<>1 THEN
    RAISE EXCEPTION 'FAIL: a score change publishes a league change';
  END IF;
  PERFORM pg_temp.clear_signals();
  UPDATE public.player_game_stats SET points=points WHERE id=v_stat;
  IF pg_temp.pending(fixture.league_id)<>0 THEN RAISE EXCEPTION 'FAIL: an unchanged stat publishes a league version'; END IF;
  IF (SELECT points FROM analytics.player_season_totals WHERE player_id=v_player AND season_year=9651) IS DISTINCT FROM 10 THEN
    RAISE EXCEPTION 'FAIL: an unchanged stat moves the season totals';
  END IF;
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,did_not_play)
    VALUES(v_player,v_game,9651,1,15,false)
    ON CONFLICT(player_id,game_id) DO UPDATE SET points=EXCLUDED.points;
  IF pg_temp.pending(fixture.league_id)<>1 THEN RAISE EXCEPTION 'FAIL: an upserted stat publishes a league version'; END IF;
  IF (SELECT points FROM analytics.player_season_totals WHERE player_id=v_player AND season_year=9651) IS DISTINCT FROM 15 THEN
    RAISE EXCEPTION 'FAIL: an upserted stat updates the season totals once';
  END IF;
  DELETE FROM public.player_game_stats WHERE player_id=v_player AND game_id=v_game AND false;
  IF NOT EXISTS(SELECT 1 FROM analytics.player_season_totals WHERE player_id=v_player AND season_year=9651) THEN
    RAISE EXCEPTION 'FAIL: an empty delete changes the season totals';
  END IF;
  DELETE FROM public.player_game_stats WHERE id=v_stat;
  IF EXISTS(SELECT 1 FROM analytics.player_season_totals WHERE player_id=v_player AND season_year=9651) THEN
    RAISE EXCEPTION 'FAIL: a deleted stat clears the season totals';
  END IF;
END;
$$;
ROLLBACK;

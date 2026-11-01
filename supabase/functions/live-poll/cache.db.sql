BEGIN;
SET LOCAL statement_timeout='30s';
CREATE TEMP TABLE live_cache_checks(label text PRIMARY KEY);
CREATE FUNCTION pg_temp.live_check(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  INSERT INTO live_cache_checks VALUES(label);
END;
$$;
DO $$
DECLARE
  game uuid := gen_random_uuid(); player uuid := gen_random_uuid(); other uuid := gen_random_uuid();
  provider text := '002-cache-'||game; snapshot jsonb; stats jsonb; before_state jsonb; before_row jsonb;
  stamp timestamptz := clock_timestamp()-interval '10 seconds'; holder uuid; work jsonb;
BEGIN
  INSERT INTO public.players(id,first_name,last_name,nba_id) VALUES
    (player,'Live','Cache One','cache-'||player),(other,'Live','Cache Two','cache-'||other);
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(game,provider,3991,1,'3991-01-01','ATL','CLE','InProgress');
  INSERT INTO private.player_game_memberships(player_id,game_id,nba_team) VALUES(player,game,'ATL'),(other,game,'CLE');
  stats := jsonb_build_array(
    jsonb_build_object('player_id',player,'game_id',game,'points',10,'did_not_play',false,'minutes_played',6),
    jsonb_build_object('player_id',other,'game_id',game,'points',8,'did_not_play',false,'minutes_played',6));
  snapshot := jsonb_build_object('source','nba','source_updated_at',stamp,'elapsed_seconds',360,'stats',stats,
    'status','InProgress','home_score',10,'away_score',8,'status_text','Q1');
  PERFORM pg_temp.live_check(public.save_live_feed_snapshot_atomic(game,provider,snapshot)=2,'first snapshot saves both lines');
  PERFORM pg_temp.live_check(EXISTS(SELECT 1 FROM private.live_game_identity_checks WHERE game_id=game),'identity proof persists');
  SELECT to_jsonb(feed)||jsonb_build_object('ctid',ctid::text) INTO before_state FROM private.live_feed_state feed WHERE game_id=game;
  SELECT to_jsonb(row)||jsonb_build_object('ctid',ctid::text,'xmax',xmax::text) INTO before_row FROM public.nba_games row WHERE id=game;
  PERFORM pg_temp.live_check(public.save_live_feed_snapshot_atomic(game,provider,snapshot)=0,'identical snapshot changes zero rows');
  PERFORM pg_temp.live_check(before_state=(SELECT to_jsonb(feed)||jsonb_build_object('ctid',ctid::text) FROM private.live_feed_state feed WHERE game_id=game),'identical feed does not rewrite cache');
  PERFORM pg_temp.live_check(before_row=(SELECT to_jsonb(row)||jsonb_build_object('ctid',ctid::text,'xmax',xmax::text) FROM public.nba_games row WHERE id=game),'identical feed does not lock or rewrite game');
  BEGIN
    PERFORM public.save_live_feed_snapshot_atomic(game,provider,jsonb_set(snapshot,'{stats}',stats||jsonb_build_array(stats->0)));
    RAISE EXCEPTION 'Duplicate cached players were accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    PERFORM pg_temp.live_check(true,'duplicate cached players remain invalid');
  END;
  SELECT live_cache INTO work FROM public.get_live_poll_work('3991-01-01T18:00:00Z') WHERE id=game;
  PERFORM pg_temp.live_check(jsonb_array_length(work->'players')=2 AND work->'snapshot' IS NOT NULL,'work carries current player links and snapshot');
  snapshot := jsonb_set(snapshot,'{stats,0,points}','12');
  PERFORM pg_temp.live_check(public.save_live_feed_snapshot_atomic(game,provider,snapshot)=1,'same-clock correction writes only changed player');
  PERFORM pg_temp.live_check((SELECT points=8 FROM public.player_game_stats WHERE game_id=game AND player_id=other),'unchanged player stays unchanged');
  UPDATE public.nba_games SET home_score=99 WHERE id=game;
  PERFORM pg_temp.live_check((SELECT stats_snapshot IS NULL FROM private.live_feed_state WHERE game_id=game),'external scoreboard change invalidates cached snapshot');
  PERFORM public.save_live_feed_snapshot_atomic(game,provider,snapshot);
  PERFORM pg_temp.live_check((SELECT home_score=10 FROM public.nba_games WHERE id=game),'identical source repairs an external scoreboard change');
  UPDATE public.player_game_stats SET points=99 WHERE game_id=game AND player_id=other;
  PERFORM pg_temp.live_check((SELECT stats_snapshot IS NULL FROM private.live_feed_state WHERE game_id=game),'external stat changes invalidate cached snapshot');
  snapshot := jsonb_set(snapshot,'{full_stats}',snapshot->'stats');
  snapshot := jsonb_set(snapshot,'{stats}','[]');
  PERFORM pg_temp.live_check(public.save_live_feed_snapshot_atomic(game,provider,snapshot)=1,'full input repairs concurrent change omitted from delta');
  UPDATE public.nba_games SET home_team='BOS' WHERE id=game;
  PERFORM pg_temp.live_check(NOT EXISTS(SELECT 1 FROM private.live_game_identity_checks WHERE game_id=game),'game identity change invalidates proof');
  PERFORM pg_temp.live_check((SELECT stats_snapshot IS NULL FROM private.live_feed_state WHERE game_id=game),'game identity change invalidates snapshot');
  PERFORM public.save_live_game_stats_atomic(game,provider,stats,361);
  PERFORM pg_temp.live_check(EXISTS(SELECT 1 FROM private.live_game_identity_checks WHERE game_id=game),'changed game is checked again');
  holder:=public.try_live_poll_lease(779001,90);
  PERFORM public.record_live_poll_attempts(holder,ARRAY[game],ARRAY[game]);
  PERFORM pg_temp.live_check(NOT EXISTS(SELECT 1 FROM private.live_poll_game_state WHERE game_id=game),'live attempts create no bookkeeping rows');
  PERFORM public.save_final_game_snapshot_atomic(game,provider,stats,stamp+interval '1 second',100,98,'Final');
  PERFORM pg_temp.live_check((SELECT status='Final' AND home_score=100 AND away_score=98 AND stats_synced_at IS NOT NULL FROM public.nba_games WHERE id=game),'final save remains complete');
  PERFORM public.save_final_game_snapshot_atomic(game,provider,jsonb_set(stats,'{0,points}','13'),stamp+interval '2 seconds',101,98,'Final');
  PERFORM pg_temp.live_check((SELECT points=13 FROM public.player_game_stats WHERE game_id=game AND player_id=player),'later final correction applies');
  UPDATE public.nba_games SET stats_synced_at='3991-01-01T17:59:00Z' WHERE id=game;
  PERFORM pg_temp.live_check(NOT EXISTS(SELECT 1 FROM public.get_live_poll_work('3991-01-01T18:00:00Z') WHERE id=game),'recent final is not due');
  UPDATE public.nba_games SET stats_synced_at='3991-01-01T17:29:00Z' WHERE id=game;
  PERFORM pg_temp.live_check(EXISTS(SELECT 1 FROM public.get_live_poll_work('3991-01-01T18:00:00Z') WHERE id=game AND needs_stats),'final correction recheck stays at thirty minutes');
  PERFORM pg_temp.live_check(NOT has_function_privilege('authenticated','public.save_live_cache_invalidate()','EXECUTE'),'cache trigger is not client callable');
END;
$$;
SELECT count(*) AS passed FROM live_cache_checks;
ROLLBACK;

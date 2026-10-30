BEGIN;
DO $$
DECLARE
  g uuid := gen_random_uuid(); p uuid := gen_random_uuid(); provider text;
  stats jsonb; audit_count integer; t timestamptz := clock_timestamp()-interval '1 minute'; sample jsonb;
BEGIN
  provider := '002-synthetic-fallback-'||g;
  INSERT INTO public.players(id,first_name,last_name) VALUES(p,'Synthetic',p::text);
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(g,provider,3993,1,'3993-01-01','XXA','XXB','InProgress');
  stats := jsonb_build_array(jsonb_build_object('player_id',p,'game_id',g,'points',10,'did_not_play',false));
  sample := jsonb_build_object('source','nba','source_updated_at',t,'elapsed_seconds',1200,'status','InProgress','home_score',40,'away_score',39,'status_text','Q2','stats',stats);
  PERFORM public.save_live_feed_snapshot_atomic(g,provider,sample);
  SELECT count(*) INTO audit_count FROM private.live_feed_audit WHERE game_id=g;
  PERFORM public.save_live_feed_snapshot_atomic(g,provider,sample);
  IF (SELECT count(*) FROM private.live_feed_audit WHERE game_id=g)<>audit_count THEN RAISE EXCEPTION 'Duplicate snapshots added audit rows'; END IF;
  PERFORM public.save_live_feed_snapshot_atomic(g,provider,sample||jsonb_build_object('source','espn','source_updated_at',t-interval '1 second','home_score',38,'stats',jsonb_set(stats,'{0,points}','8')));
  IF (SELECT home_score<>40 FROM public.nba_games WHERE id=g) OR (SELECT points<>10 FROM public.player_game_stats WHERE game_id=g) THEN RAISE EXCEPTION 'Older ESPN overwrote fresher NBA'; END IF;
  PERFORM public.save_live_feed_snapshot_atomic(g,provider,sample||jsonb_build_object('source','espn','source_updated_at',t+interval '1 second','home_score',42,'stats',jsonb_set(stats,'{0,points}','12')));
  PERFORM public.save_live_feed_snapshot_atomic(g,provider,sample);
  PERFORM public.save_live_game_stats_atomic(g,provider,stats,1200);
  PERFORM public.save_live_scoreboard_atomic(g,provider,'InProgress',40,39,'Q2',1200);
  IF (SELECT home_score<>42 FROM public.nba_games WHERE id=g) OR (SELECT points<>12 FROM public.player_game_stats WHERE game_id=g) THEN RAISE EXCEPTION 'NBA regressed fallback at the same clock'; END IF;
  PERFORM public.save_live_feed_snapshot_atomic(g,provider,sample||jsonb_build_object('source_updated_at',t+interval '2 seconds','stats',jsonb_set(stats,'{0,points}','13')));
  IF (SELECT points<>13 FROM public.player_game_stats WHERE game_id=g) THEN RAISE EXCEPTION 'NBA did not resume after catching up'; END IF;
  PERFORM public.save_live_feed_snapshot_atomic(g,provider,sample||jsonb_build_object('source','espn','source_updated_at',t+interval '3 seconds','elapsed_seconds',1100));
  IF (SELECT points<>13 FROM public.player_game_stats WHERE game_id=g) THEN RAISE EXCEPTION 'Older progress regressed stats'; END IF;
  BEGIN
    PERFORM public.save_live_feed_snapshot_atomic(g,provider,sample||jsonb_build_object('source','espn','status','Final'));
    RAISE EXCEPTION 'ESPN finalized stats';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  IF (SELECT stats_synced_at IS NOT NULL FROM public.nba_games WHERE id=g)
    OR EXISTS(SELECT 1 FROM private.game_stat_revisions WHERE game_id=g) THEN RAISE EXCEPTION 'Live fallback certified official stats'; END IF;
  IF NOT EXISTS(SELECT 1 FROM private.live_feed_audit WHERE game_id=g AND source='espn' AND stat_rows_changed>0)
    OR NOT EXISTS(SELECT 1 FROM private.live_feed_audit WHERE game_id=g AND source='nba' AND stat_rows_changed>0) THEN RAISE EXCEPTION 'Changed live writes lost their source audit'; END IF;
  PERFORM public.save_final_game_snapshot_atomic(g,provider,jsonb_set(stats,'{0,points}','7'),t-interval '1 hour',100,99,'Final');
  IF (SELECT points<>7 FROM public.player_game_stats WHERE game_id=g) OR NOT EXISTS(SELECT 1 FROM private.game_stat_revisions WHERE game_id=g) THEN RAISE EXCEPTION 'NBA certification did not replace divergent ESPN live values'; END IF;
  PERFORM public.save_final_game_snapshot_atomic(g,provider,jsonb_set(stats,'{0,points}','8'),t,101,99,'Final');
  IF (SELECT points<>8 FROM public.player_game_stats WHERE game_id=g) THEN RAISE EXCEPTION 'The NBA correction audit could not update an ESPN live game'; END IF;
  PERFORM public.save_live_feed_snapshot_atomic(g,provider,sample||jsonb_build_object('source','espn','source_updated_at',t+interval '4 seconds','elapsed_seconds',2880));
  IF (SELECT status<>'Final' OR home_score<>101 FROM public.nba_games WHERE id=g) OR (SELECT points<>8 FROM public.player_game_stats WHERE game_id=g) THEN RAISE EXCEPTION 'Late ESPN changed NBA final'; END IF;
  IF has_function_privilege('authenticated','public.save_live_feed_snapshot_atomic(uuid,text,jsonb)','EXECUTE') OR has_function_privilege('anon','public.save_live_feed_snapshot_atomic(uuid,text,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Clients can write feed snapshots'; END IF;
END;
$$;
ROLLBACK;
SELECT 'Live fallback timestamp, progress, NBA resumption, final and grant guards: PASS';

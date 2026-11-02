-- Canonical SQL source for public.save_live_game_stats_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.save_live_game_stats_atomic(
  p_game_id uuid, p_provider_game_id text, p_stats jsonb, p_elapsed_seconds numeric
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_game public.nba_games%ROWTYPE; v_year integer; v_changed integer;
BEGIN
  IF p_elapsed_seconds IS NULL OR p_elapsed_seconds<0 OR p_elapsed_seconds='NaN'::numeric THEN
    RAISE EXCEPTION 'Live game progress is required.' USING ERRCODE='22023';
  END IF;
  SELECT season_year INTO v_year FROM public.nba_games WHERE id=p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'NBA game not found.' USING ERRCODE='P0002'; END IF;
  PERFORM private.lock_nba_source(v_year);
  SELECT * INTO v_game FROM public.nba_games WHERE id=p_game_id FOR UPDATE;
  IF v_game.season_year IS DISTINCT FROM v_year OR v_game.nba_game_id IS DISTINCT FROM p_provider_game_id THEN
    RAISE EXCEPTION 'Game inputs changed. Retry.' USING ERRCODE='PT409';
  END IF;
  IF current_setting('app.live_feed_game',true) IS DISTINCT FROM p_game_id::text
    AND EXISTS(SELECT 1 FROM private.live_feed_state WHERE game_id=p_game_id AND stats_source='espn')
    AND v_game.live_stats_elapsed_seconds>=p_elapsed_seconds THEN RETURN 0; END IF;
  IF v_game.status='Final' OR v_game.live_stats_elapsed_seconds>p_elapsed_seconds THEN RETURN 0; END IF;
  v_changed := public.save_game_stats_atomic(p_game_id,p_provider_game_id,p_stats,false);
  IF current_setting('app.live_feed_game',true) IS DISTINCT FROM p_game_id::text THEN
    UPDATE private.live_feed_state SET nba_player_ids=ARRAY(
      SELECT DISTINCT player FROM unnest(nba_player_ids||private.live_nba_witnesses(p_stats)) player ORDER BY player),
      espn_only_player_ids=ARRAY(SELECT player FROM unnest(espn_only_player_ids) player
        WHERE NOT player=ANY(private.live_nba_witnesses(p_stats)))
      WHERE game_id=p_game_id AND players_initialized
        AND (NOT private.live_nba_witnesses(p_stats)<@nba_player_ids OR private.live_nba_witnesses(p_stats)&&espn_only_player_ids);
    IF v_changed>0 THEN
      INSERT INTO private.live_feed_audit(game_id,source,source_updated_at,elapsed_seconds,stat_rows_changed,scoreboard_changed)
        VALUES(p_game_id,'nba',NULL,p_elapsed_seconds,v_changed,false);
    END IF;
  END IF;
  UPDATE public.nba_games SET live_stats_elapsed_seconds=p_elapsed_seconds WHERE id=p_game_id AND live_stats_elapsed_seconds IS DISTINCT FROM p_elapsed_seconds;
  RETURN v_changed;
END;
$$;

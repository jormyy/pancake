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
  IF v_game.status='Final' OR v_game.live_stats_elapsed_seconds>p_elapsed_seconds THEN RETURN 0; END IF;
  v_changed := public.save_game_stats_atomic(p_game_id,p_provider_game_id,p_stats,false);
  UPDATE public.nba_games SET live_stats_elapsed_seconds=p_elapsed_seconds WHERE id=p_game_id;
  RETURN v_changed;
END;
$$;

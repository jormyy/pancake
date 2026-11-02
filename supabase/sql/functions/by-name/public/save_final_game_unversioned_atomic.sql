CREATE OR REPLACE FUNCTION public.save_final_game_unversioned_atomic(p_game_id uuid,p_provider_game_id text,p_stats jsonb,p_home_score integer,p_away_score integer,p_status_text text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_year integer; v_game public.nba_games%ROWTYPE;
BEGIN
  SELECT season_year INTO v_year FROM public.nba_games WHERE id=p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'NBA game not found.' USING ERRCODE='P0002'; END IF;
  PERFORM private.lock_nba_source(v_year);
  SELECT * INTO v_game FROM public.nba_games WHERE id=p_game_id FOR UPDATE;
  IF v_game.season_year IS DISTINCT FROM v_year OR v_game.nba_game_id IS DISTINCT FROM p_provider_game_id THEN
    RAISE EXCEPTION 'Game inputs changed. Retry.' USING ERRCODE='PT409';
  END IF;
  PERFORM public.save_live_scoreboard_atomic(p_game_id,p_provider_game_id,'Final',p_home_score,p_away_score,p_status_text,0);
  RETURN public.save_game_stats_atomic(p_game_id,p_provider_game_id,p_stats,true);
END;
$$;

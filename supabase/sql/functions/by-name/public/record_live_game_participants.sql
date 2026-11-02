CREATE OR REPLACE FUNCTION public.record_live_game_participants(p_game_id uuid,p_provider_game_id text,p_player_ids text[],p_observed_at timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_game public.nba_games%ROWTYPE; v_changed integer;
BEGIN
  IF p_player_ids IS NULL OR p_observed_at IS NULL OR NOT isfinite(p_observed_at) OR p_observed_at>clock_timestamp()+interval '5 seconds'
    OR p_observed_at<clock_timestamp()-interval '2 minutes' OR cardinality(p_player_ids)>100
    OR EXISTS(SELECT 1 FROM unnest(p_player_ids) player WHERE player IS NULL OR player!~'^[0-9]+$') THEN
    RAISE EXCEPTION 'Fresh NBA participation evidence is required.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_game FROM public.nba_games WHERE id=p_game_id FOR UPDATE;
  IF NOT FOUND OR v_game.nba_game_id IS DISTINCT FROM p_provider_game_id THEN
    RAISE EXCEPTION 'Game provider identity changed.' USING ERRCODE='PT409';
  END IF;
  IF v_game.status='Final' THEN RETURN 0; END IF;
  INSERT INTO private.live_game_participants(game_id,nba_id)
    SELECT p_game_id,player FROM unnest(p_player_ids) player ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  RETURN v_changed;
END;
$$;

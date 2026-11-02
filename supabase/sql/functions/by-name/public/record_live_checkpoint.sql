CREATE OR REPLACE FUNCTION public.record_live_checkpoint(p_holder uuid,p_game_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.lock_live_poll_holder(p_holder);
  INSERT INTO private.live_poll_game_state(game_id,checkpoint_at)
    SELECT id,clock_timestamp() FROM public.nba_games WHERE id=ANY(p_game_ids) ORDER BY id
    ON CONFLICT(game_id) DO UPDATE SET checkpoint_at=EXCLUDED.checkpoint_at;
END;
$$;

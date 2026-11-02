CREATE OR REPLACE FUNCTION public.record_live_recovery_failure(p_holder uuid,p_game_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.lock_live_poll_holder(p_holder);
  INSERT INTO private.live_poll_game_state(game_id,recovery_failed_at)
    VALUES(p_game_id,clock_timestamp())
    ON CONFLICT(game_id) DO UPDATE SET recovery_failed_at=EXCLUDED.recovery_failed_at;
END;
$$;

-- Canonical SQL source for public.record_live_poll_attempts.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.record_live_poll_attempts(
  p_holder uuid, p_checked_ids uuid[] DEFAULT ARRAY[]::uuid[], p_stats_ids uuid[] DEFAULT ARRAY[]::uuid[]
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.lock_live_poll_holder(p_holder);
  INSERT INTO private.live_poll_game_state(game_id,checked_at,stats_attempted_at)
    SELECT game.id,
      CASE WHEN game.id=ANY(p_checked_ids) AND game.status<>'InProgress' THEN clock_timestamp() END,
      CASE WHEN game.id=ANY(p_stats_ids) AND game.status='Final' THEN clock_timestamp() END
    FROM public.nba_games game WHERE (game.id=ANY(p_checked_ids) AND game.status<>'InProgress') OR (game.id=ANY(p_stats_ids) AND game.status='Final')
    ORDER BY game.id
    ON CONFLICT(game_id) DO UPDATE SET
      checked_at=COALESCE(EXCLUDED.checked_at,live_poll_game_state.checked_at),
      stats_attempted_at=COALESCE(EXCLUDED.stats_attempted_at,live_poll_game_state.stats_attempted_at);
END;
$$;

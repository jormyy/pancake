-- Canonical SQL source for public.expire_trade_completion_failure_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.expire_trade_completion_failure_atomic(
  p_trade_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_rows int;
  v_league_status text;
  v_is_current boolean;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
     AND status = 'accepted'
     AND veto_window_expires_at <= now()
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade is not an expired accepted trade';
  END IF;

  SELECT status
    INTO v_league_status
    FROM leagues
   WHERE id = v_trade.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  SELECT is_current
    INTO v_is_current
    FROM league_seasons
   WHERE id = v_trade.league_season_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade season not found.';
  END IF;

  IF v_is_current IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Trades require the current season.';
  END IF;

  IF v_league_status = 'archived' THEN
    RAISE EXCEPTION 'Archived leagues are read-only.';
  END IF;

  UPDATE trades
     SET status = 'expired',
         completed_at = NULL,
         completion_failure_reason = p_reason
   WHERE id = p_trade_id
     AND status = 'accepted';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to expire accepted trade';
  END IF;
END;
$$;

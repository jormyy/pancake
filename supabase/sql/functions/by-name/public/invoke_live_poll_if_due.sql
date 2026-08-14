-- Canonical SQL source for public.invoke_live_poll_if_due.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.invoke_live_poll_if_due()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (timezone('America/New_York', now()))::date;
BEGIN
  -- Mirrors livePollCandidateDates() in the edge function: yesterday + today
  -- ET, so late West-coast games that cross ET midnight stay covered.
  IF EXISTS (
    SELECT 1
      FROM public.nba_games
     WHERE game_date IN (v_today - 1, v_today)
       AND status <> 'Final'
  ) THEN
    PERFORM public.invoke_edge_function('live-poll');
  END IF;
END;
$$;

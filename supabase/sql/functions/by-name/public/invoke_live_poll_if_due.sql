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
  -- A game already marked Final whose box score was never written (the
  -- function was down when it ended) must also wake the poll, or its stats
  -- are never fetched.
  IF EXISTS (
    SELECT 1
      FROM public.nba_games
     WHERE game_date IN (v_today - 1, v_today)
       AND status <> 'Final'
  ) OR EXISTS (
    SELECT 1
      FROM public.nba_games AS game
     WHERE game.game_date IN (v_today - 1, v_today)
       AND game.status = 'Final'
       AND NOT EXISTS (
         SELECT 1 FROM public.player_game_stats AS stat WHERE stat.game_id = game.id
       )
  ) THEN
    PERFORM public.invoke_edge_function('live-poll');
  END IF;
END;
$$;

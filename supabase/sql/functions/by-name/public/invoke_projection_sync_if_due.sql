-- Canonical SQL source for public.invoke_projection_sync_if_due.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.invoke_projection_sync_if_due()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (timezone('America/New_York', now()))::date;
  v_now_et timestamp := timezone('America/New_York', now());
  v_first_lock timestamptz;
  v_has_games boolean := false;
BEGIN
  SELECT min(game_time), bool_or(true)
    INTO v_first_lock, v_has_games
    FROM public.nba_games
   WHERE game_date = v_today
     AND game_time IS NOT NULL
     AND public.is_regular_season_game_id(nba_game_id);

  -- Backend cron calls this hourly. It invokes the scraper in the morning, then
  -- hourly until the first NBA game locks on scheduled game days. On no-game
  -- days it still refreshes once in the morning so weekly projections stay warm.
  IF EXTRACT(HOUR FROM v_now_et)::int = 8 THEN
    PERFORM public.invoke_edge_function('sync-projections');
  ELSIF v_has_games AND v_first_lock IS NOT NULL AND now() < v_first_lock THEN
    PERFORM public.invoke_edge_function('sync-projections');
  END IF;
END;
$$;

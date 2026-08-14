-- Canonical SQL source for public.invoke_lineup_optimizer_if_due.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.invoke_lineup_optimizer_if_due()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (timezone('America/New_York', now()))::date;
BEGIN
  -- Mirrors loadDateContexts() in the edge function: today through today+7 ET.
  IF EXISTS (
    SELECT 1
      FROM public.nba_games
     WHERE game_date BETWEEN v_today AND v_today + 7
  ) THEN
    PERFORM public.invoke_edge_function('lineup-optimizer');
  END IF;
END;
$$;

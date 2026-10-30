-- Canonical SQL source for private.enqueue_lineup_optimizer.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.enqueue_lineup_optimizer(p_now timestamptz DEFAULT now())
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (timezone('America/New_York', p_now))::date;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.nba_games
     WHERE game_date BETWEEN v_today AND v_today + 7
  ) THEN
    PERFORM private.work_enqueue('lineup-optimizer',date_trunc('minute',p_now)::text,p_now);
  END IF;
END;
$$;

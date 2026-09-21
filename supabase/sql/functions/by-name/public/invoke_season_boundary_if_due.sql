-- Canonical SQL source for public.invoke_season_boundary_if_due.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.invoke_season_boundary_if_due(
  p_now timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamp := timezone('America/New_York', p_now);
BEGIN
  -- Due from 09:00 ET onward, once per ET day; a tick delayed past the 9 o'clock
  -- hour used to skip the whole day's bracket/rollover work.
  IF v_now::time < make_time(9, 0, 0) THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.leagues
     WHERE status IN (
       'active'::public.league_status,
       'playoffs'::public.league_status,
       'offseason'::public.league_status
     )
  ) THEN
    RETURN;
  END IF;

  IF NOT private.claim_cron_dispatch('season-boundary', to_char(v_now, 'YYYY-MM-DD')) THEN
    RETURN;
  END IF;
  PERFORM public.invoke_edge_function('season-boundary');
END;
$$;

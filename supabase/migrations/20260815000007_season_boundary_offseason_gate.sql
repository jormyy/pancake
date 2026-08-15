-- The season-boundary invoker gated on leagues in ('active','playoffs'), but
-- rollover parks every league in 'offseason' — in a normal June-September the
-- whole fleet is offseason simultaneously, so the tick that owns the offseason
-- work (matchup backfill, rookie-draft week-1 backstop) would never fire.
-- Idle gating now means "no league in any boundary-relevant status", which
-- still keeps setup/archived-only projects quiet.

CREATE OR REPLACE FUNCTION public.invoke_season_boundary_if_due()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamp := timezone('America/New_York', now());
BEGIN
  IF EXTRACT(HOUR FROM v_now)::int <> 9 THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.leagues
     WHERE status IN (
       'active'::public.league_status,
       'playoffs'::public.league_status,
       'offseason'::public.league_status
     )
  ) THEN
    PERFORM public.invoke_edge_function('season-boundary');
  END IF;
END;
$$;

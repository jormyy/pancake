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

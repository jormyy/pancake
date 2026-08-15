-- Season-boundary automation: a daily cron invokes the season-boundary edge
-- function, which per league generates the playoff bracket when the regular
-- season finalizes, advances the bracket round by round, rolls the season over
-- after the final, and generates the next season's matchups. The invoker
-- follows the invoke_live_poll_if_due() idle-gate pattern: outside the ET
-- window, or with no league in a boundary-relevant status, no edge invocation
-- happens and offseason cost stays near zero.

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
     WHERE status IN ('active'::public.league_status, 'playoffs'::public.league_status)
  ) THEN
    PERFORM public.invoke_edge_function('season-boundary');
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_season_boundary_if_due() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_season_boundary_if_due() FROM anon;
REVOKE ALL ON FUNCTION public.invoke_season_boundary_if_due() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_season_boundary_if_due() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- 9:00 ET is 13:00 UTC during EDT and 14:00 UTC during EST; the function
    -- gates on the ET hour so exactly one of the two fires each day.
    PERFORM cron.schedule(
      'season-boundary',
      '0 13,14 * * *',
      $job$SELECT public.invoke_season_boundary_if_due()$job$
    );
  END IF;
END $$;

-- ============================================================
-- Gate the lineup-optimizer cron
--
-- nba-lineup-optimizer ran every 10 minutes year-round (144 invocations/day)
-- even when no NBA games exist in the optimizer's 7-day window, paying an edge
-- invocation plus an nba_games query per tick offseason. Follow the
-- invoke_live_poll_if_due() pattern: a SQL predicate that mirrors the edge
-- function's loadDateContexts() window (today .. today+7 ET) and only invokes
-- the function when a game exists in that range.
-- ============================================================

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

REVOKE ALL ON FUNCTION public.invoke_lineup_optimizer_if_due() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_lineup_optimizer_if_due() FROM anon;
REVOKE ALL ON FUNCTION public.invoke_lineup_optimizer_if_due() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_lineup_optimizer_if_due() TO service_role;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('nba-lineup-optimizer') WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'nba-lineup-optimizer'
    );
    PERFORM cron.schedule(
      'nba-lineup-optimizer',
      '*/10 * * * *',
      $$SELECT public.invoke_lineup_optimizer_if_due()$$
    );
  END IF;
END
$cron$;

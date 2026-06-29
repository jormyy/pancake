-- Supabase backend cutover:
-- - pg_cron invokes Edge Functions through public.invoke_edge_function.
-- - accepted-trade completion and auction nomination expiry move out of the
--   former interval loops and into Supabase Cron + Edge Functions.
--
-- Required hosted DB secret after deploy:
--   select vault.create_secret('<PANCAKE_EDGE_INTERNAL_TOKEN>', 'pancake_edge_internal_token');

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('nba-process-trades') WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'nba-process-trades'
    );
    PERFORM cron.unschedule('nba-close-expired-nominations') WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'nba-close-expired-nominations'
    );

    PERFORM cron.schedule(
      'nba-process-trades',
      '*/5 * * * *',
      $$SELECT public.invoke_edge_function('process-trades')$$
    );
    PERFORM cron.schedule(
      'nba-close-expired-nominations',
      '* * * * *',
      $$SELECT public.invoke_edge_function('close-expired-nominations')$$
    );
  END IF;
END
$cron$;

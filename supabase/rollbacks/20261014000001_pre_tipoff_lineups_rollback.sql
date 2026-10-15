BEGIN;
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('nba-lineup-optimizer') WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'nba-lineup-optimizer'
    );
    PERFORM cron.schedule('nba-lineup-optimizer', '*/10 * * * *',
      'SELECT public.invoke_lineup_optimizer_if_due()');
  END IF;
END
$cron$;
UPDATE public.lineup_tipoff_dispatches
   SET token = gen_random_uuid(), status = 'failed', lease_until = NULL, error = 'Scheduler rollback'
 WHERE status IN ('pending', 'queued', 'running');
COMMIT;

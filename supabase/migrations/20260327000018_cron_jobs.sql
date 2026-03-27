-- ============================================================
-- NBA Data Pipeline: pg_cron + pg_net scheduling
-- ============================================================
--
-- SETUP REQUIRED (run once after deploying this migration):
--   1. Enable pg_net in Supabase Dashboard → Database → Extensions
--   2. Enable pg_cron in Supabase Dashboard → Database → Extensions
--   3. Set your credentials (replace the values):
--
--   ALTER DATABASE postgres SET app.supabase_url = 'https://ceeytbfmwsnzalxlkalc.supabase.co';
--   ALTER DATABASE postgres SET app.service_role_key = '<your-service-role-key>';
--
-- These settings persist across restarts but are NOT committed to version control.
-- ============================================================

-- Enable extensions (safe to run if already enabled)
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Helper function: invoke a Supabase Edge Function via HTTP
CREATE OR REPLACE FUNCTION invoke_edge_function(
  function_name text,
  body jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  _url text;
  _key text;
BEGIN
  _url := current_setting('app.supabase_url', true) || '/functions/v1/' || function_name;
  _key := current_setting('app.service_role_key', true);

  IF _url IS NULL OR _key IS NULL THEN
    RAISE WARNING '[cron] app.supabase_url or app.service_role_key not set. Skipping %.', function_name;
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := _url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || _key,
      'Content-Type',  'application/json'
    ),
    body    := body::text
  );
END;
$$;

-- ============================================================
-- Remove any existing cron jobs with these names (idempotent)
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobname) FROM cron.job
      WHERE jobname IN (
        'nba-sync-players', 'nba-sync-schedule',
        'nba-sync-stats-hourly', 'nba-sync-scores',
        'nba-sync-projections', 'nba-sync-rankings',
        'nba-process-waivers', 'nba-live-poll'
      );
  END IF;
END;
$$;

-- ============================================================
-- Cron schedules (all times UTC; season runs Oct–Apr)
-- ET = UTC-4 (EDT) during most of the season
-- ============================================================

-- Daily 6 AM ET (10:00 UTC): sync players from Sleeper API
SELECT cron.schedule(
  'nba-sync-players',
  '0 10 * * *',
  $$SELECT invoke_edge_function('sync-players')$$
);

-- Daily 6:05 AM ET (10:05 UTC): sync schedule from NBA CDN
SELECT cron.schedule(
  'nba-sync-schedule',
  '5 10 * * *',
  $$SELECT invoke_edge_function('sync-schedule')$$
);

-- Daily 8 AM ET (12:00 UTC): compute rolling projection averages
SELECT cron.schedule(
  'nba-sync-projections',
  '0 12 * * *',
  $$SELECT invoke_edge_function('sync-projections')$$
);

-- Weekly Monday 7 AM ET (11:00 UTC): dynasty rankings
SELECT cron.schedule(
  'nba-sync-rankings',
  '0 11 * * 1',
  $$SELECT invoke_edge_function('sync-rankings')$$
);

-- Daily 3 AM ET (07:00 UTC): process pending waiver claims
SELECT cron.schedule(
  'nba-process-waivers',
  '0 7 * * *',
  $$SELECT invoke_edge_function('process-waivers')$$
);

-- Every 1 minute during game hours (11 AM – 1 AM ET = 15:00–05:00 UTC):
-- Checks for active games and syncs stats + scores when live
SELECT cron.schedule(
  'nba-live-poll',
  '* 15-23,0-4 * * *',
  $$SELECT invoke_edge_function('live-poll')$$
);

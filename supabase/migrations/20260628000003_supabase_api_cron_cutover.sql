-- Supabase backend cutover:
-- - pg_cron invokes Edge Functions with the dedicated internal token header.
-- - accepted-trade completion and auction nomination expiry move out of the
--   Railway/Fastify interval loops and into Supabase Cron + Edge Functions.
--
-- Required hosted DB secret after deploy:
--   select vault.create_secret('<PANCAKE_EDGE_INTERNAL_TOKEN>', 'pancake_edge_internal_token');

CREATE OR REPLACE FUNCTION public.invoke_edge_function(
  function_name text,
  body jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _base_url text;
  _internal_token text;
BEGIN
  _base_url := COALESCE(
    NULLIF(current_setting('app.supabase_url', true), ''),
    'https://ceeytbfmwsnzalxlkalc.supabase.co'
  );
  _internal_token := NULLIF(current_setting('app.edge_internal_token', true), '');

  IF _internal_token IS NULL THEN
    SELECT NULLIF(decrypted_secret, '')
      INTO _internal_token
      FROM vault.decrypted_secrets
     WHERE name = 'pancake_edge_internal_token'
     ORDER BY updated_at DESC NULLS LAST, created_at DESC
     LIMIT 1;
  END IF;

  IF _base_url IS NULL OR _internal_token IS NULL THEN
    RAISE WARNING
      '[cron] Supabase Edge base URL or internal token not set; skipping %.',
      function_name;
    RETURN;
  END IF;

  PERFORM net.http_post(
    _base_url || '/functions/v1/' || function_name,
    body,
    NULL,
    jsonb_build_object(
      'x-internal-function-token', _internal_token,
      'Content-Type', 'application/json'
    ),
    30000
  );
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_edge_function(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_edge_function(text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.invoke_edge_function(text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_edge_function(text, jsonb) TO service_role;

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

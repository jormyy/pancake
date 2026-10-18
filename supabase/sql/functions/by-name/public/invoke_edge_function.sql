-- Canonical SQL source for public.invoke_edge_function.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
  _request_id bigint;
  _invocation_key uuid := gen_random_uuid();
  _claim public.cron_dispatch_state%ROWTYPE;
BEGIN
  _base_url := NULLIF(rtrim(current_setting('app.supabase_url', true), '/'), '');
  _internal_token := NULLIF(current_setting('app.edge_internal_token', true), '');

  -- Managed Supabase denies ALTER DATABASE/ROLE SET for app.* GUCs, so the
  -- base URL falls back to Vault exactly like the internal token does. The
  -- missing GUC silently killed every cron->edge invocation from 2026-06-28
  -- to 2026-08-15.
  IF _base_url IS NULL THEN
    SELECT NULLIF(rtrim(decrypted_secret, '/'), '')
      INTO _base_url
      FROM vault.decrypted_secrets
     WHERE name = 'pancake_supabase_url'
     ORDER BY updated_at DESC NULLS LAST, created_at DESC
     LIMIT 1;
  END IF;

  IF _internal_token IS NULL THEN
    SELECT NULLIF(decrypted_secret, '')
      INTO _internal_token
      FROM vault.decrypted_secrets
     WHERE name = 'pancake_edge_internal_token'
     ORDER BY updated_at DESC NULLS LAST, created_at DESC
     LIMIT 1;
  END IF;

  IF _base_url IS NULL THEN
    RAISE EXCEPTION '[cron] Supabase Edge base URL is not configured.';
  END IF;

  IF _internal_token IS NULL THEN
    RAISE EXCEPTION '[cron] Supabase Edge internal token is not configured.';
  END IF;

  SELECT net.http_post(
    _base_url || '/functions/v1/' || function_name,
    body,
    NULL,
    jsonb_build_object(
      'x-internal-function-token', _internal_token,
      'Content-Type', 'application/json',
      'x-pancake-invocation-id', _invocation_key::text
    ),
    30000
  ) INTO _request_id;

  SELECT * INTO _claim FROM public.cron_dispatch_state
   WHERE job_key = NULLIF(current_setting('pancake.cron_job_key', true), '');
  INSERT INTO public.edge_invocations (
    function_name, request_id, invocation_key, dispatch_job_key, dispatch_period_key, dispatch_claimed_at
  ) VALUES (
    function_name, _request_id, _invocation_key, _claim.job_key, _claim.period_key, _claim.dispatched_at
  );
END;
$$;

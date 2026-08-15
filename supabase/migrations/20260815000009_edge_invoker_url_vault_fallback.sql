-- invoke_edge_function required the app.supabase_url GUC, which managed
-- Supabase does not allow setting (ALTER DATABASE/ROLE SET app.* -> 42501).
-- The GUC was never configured in production, so every cron->edge invocation
-- (trade completion, nomination expiry, all data syncs, waiver processing)
-- failed from 2026-06-28 until 2026-08-15. The base URL now falls back to the
-- Vault secret pancake_supabase_url, mirroring the existing token fallback.
-- The secret itself is environment-specific and seeded out-of-band.

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

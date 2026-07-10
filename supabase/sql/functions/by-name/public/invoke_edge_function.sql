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
BEGIN
  _base_url := NULLIF(rtrim(current_setting('app.supabase_url', true), '/'), '');
  _internal_token := NULLIF(current_setting('app.edge_internal_token', true), '');

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

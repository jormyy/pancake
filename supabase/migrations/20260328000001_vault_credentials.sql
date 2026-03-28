-- Restore invoke_edge_function to use current_setting (as migration 018 had it).
-- Migration 019 overwrote this with a hardcoded key — revert that.
-- The key is stored as a db setting (not committed to version control):
--   ALTER DATABASE postgres SET app.service_role_key = '<your-service-role-key>';

CREATE OR REPLACE FUNCTION invoke_edge_function(
  function_name text,
  body          jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _url text;
  _key text;
BEGIN
  _url := current_setting('app.supabase_url', true) || '/functions/v1/' || function_name;
  _key := current_setting('app.service_role_key', true);

  IF _url IS NULL OR _key IS NULL THEN
    RAISE WARNING '[cron] app.supabase_url or app.service_role_key not set — skipping %.', function_name;
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

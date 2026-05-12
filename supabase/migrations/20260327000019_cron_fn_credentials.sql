-- Update invoke_edge_function with correct pg_net signature and project settings.
-- net.http_post(url, body jsonb, params jsonb, headers jsonb, timeout_ms int)
-- The service role key must be provided by the database setting
-- app.service_role_key. Never commit a literal service role JWT here.
CREATE OR REPLACE FUNCTION invoke_edge_function(
  function_name text,
  body jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM net.http_post(
    'https://ceeytbfmwsnzalxlkalc.supabase.co/functions/v1/' || function_name,
    body,
    NULL,
    jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key', true),
      'Content-Type',  'application/json'
    ),
    30000
  );
END;
$$;

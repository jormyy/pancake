-- Update invoke_edge_function with correct pg_net signature and project credentials
-- net.http_post(url, body jsonb, params jsonb, headers jsonb, timeout_ms int)
-- SECURITY DEFINER: function body not visible to regular users
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
      'Authorization', 'Bearer <redacted-service-role-jwt>',
      'Content-Type',  'application/json'
    ),
    30000
  );
END;
$$;

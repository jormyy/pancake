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
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlZXl0YmZtd3NuemFseGxrYWxjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjE0MzI5MCwiZXhwIjoyMDg3NzE5MjkwfQ.7qewzCBGB9yRvMm_Sb62Cip6-RpR0Cn_4X4o2G62yZI',
      'Content-Type',  'application/json'
    ),
    30000
  );
END;
$$;

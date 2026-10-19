CREATE OR REPLACE FUNCTION private.invoke_claimed_edge_function(
  p_job_key text,
  p_function_name text,
  p_body jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_previous text := COALESCE(current_setting('pancake.cron_job_key', true), '');
BEGIN
  PERFORM set_config('pancake.cron_job_key', p_job_key, true);
  PERFORM public.invoke_edge_function(p_function_name, p_body);
  PERFORM set_config('pancake.cron_job_key', v_previous, true);
END;
$$;

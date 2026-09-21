-- Canonical SQL source for public.invoke_edge_function_at_et_time.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.invoke_edge_function_at_et_time(
  p_function_name text,
  p_hour int,
  p_minute int DEFAULT 0,
  p_now timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamp := timezone('America/New_York', p_now);
BEGIN
  -- Due from the target ET time onward, dispatched at most once per ET day.
  -- Equality on the minute skipped the whole day whenever pg_cron ran late.
  IF v_now::time < make_time(p_hour, p_minute, 0) THEN
    RETURN;
  END IF;
  IF NOT private.claim_cron_dispatch('et-time:' || p_function_name, to_char(v_now, 'YYYY-MM-DD')) THEN
    RETURN;
  END IF;
  PERFORM public.invoke_edge_function(p_function_name);
END;
$$;

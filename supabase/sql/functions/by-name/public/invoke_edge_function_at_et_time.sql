-- Canonical SQL source for public.invoke_edge_function_at_et_time.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.invoke_edge_function_at_et_time(
  p_function_name text,
  p_hour int,
  p_minute int DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamp;
BEGIN
  v_now := timezone('America/New_York', now());
  IF EXTRACT(HOUR FROM v_now)::int = p_hour
     AND EXTRACT(MINUTE FROM v_now)::int = p_minute THEN
    PERFORM public.invoke_edge_function(p_function_name);
  END IF;
END;
$$;

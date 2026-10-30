-- Canonical SQL source for public.finish_lineup_tipoff_dispatch.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.finish_lineup_tipoff_dispatch(p_tipoff_at timestamptz, p_token uuid, p_error text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.lineup_tipoff_dispatches
     SET status = CASE WHEN p_error IS NULL THEN 'succeeded' ELSE 'failed' END,
         error = p_error, finished_at = now()
   WHERE tipoff_at = p_tipoff_at AND token = p_token AND status = 'running' AND lease_until > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'Tipoff lease expired or changed' USING ERRCODE='40001'; END IF;
END;
$$;

-- Canonical SQL source for public.finish_lineup_tipoff_dispatch.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.finish_lineup_tipoff_dispatch(p_tipoff_at timestamptz, p_token uuid, p_error text DEFAULT NULL, p_scope text DEFAULT '')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admitted boolean := true;
  v_dispatch public.lineup_tipoff_dispatches%ROWTYPE;
BEGIN
  SELECT * INTO v_dispatch FROM public.lineup_tipoff_dispatches
   WHERE tipoff_at = p_tipoff_at AND scope = p_scope AND token = p_token
     AND status = 'running' AND lease_until > clock_timestamp()
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tipoff lease expired or changed' USING ERRCODE='40001'; END IF;
  IF p_scope <> '' THEN
    v_admitted := private.tipoff_scope_admits(p_scope, p_scope::uuid, true);
  END IF;
  UPDATE public.lineup_tipoff_dispatches
     SET status = CASE WHEN p_error IS NULL AND v_admitted THEN 'succeeded' ELSE 'failed' END,
         error = CASE WHEN p_error IS NULL AND NOT v_admitted THEN 'Tipoff scope is no longer active.' ELSE p_error END,
         finished_at = now()
   WHERE tipoff_at = p_tipoff_at AND scope = p_scope AND token = p_token AND status = 'running' AND lease_until > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'Tipoff lease expired or changed' USING ERRCODE='40001'; END IF;
END;
$$;

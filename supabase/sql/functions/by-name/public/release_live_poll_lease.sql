-- Canonical SQL source for public.release_live_poll_lease.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.release_live_poll_lease(
  p_lock_key  bigint,
  p_holder_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows integer;
BEGIN
  DELETE FROM public.live_poll_leases
   WHERE lock_key  = p_lock_key
     AND holder_id = p_holder_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

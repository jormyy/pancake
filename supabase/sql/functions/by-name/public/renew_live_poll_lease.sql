-- Canonical SQL source for public.renew_live_poll_lease.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.renew_live_poll_lease(
  p_lock_key    bigint,
  p_holder_id   uuid,
  p_ttl_seconds integer DEFAULT 90
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
BEGIN
  -- Only the current, unexpired holder may extend its lease. A holder that
  -- already lost the lease (TTL lapsed and another worker took over) gets
  -- false and must stop treating itself as the poller.
  UPDATE public.live_poll_leases
     SET expires_at = v_now + make_interval(secs => GREATEST(p_ttl_seconds, 1))
   WHERE lock_key  = p_lock_key
     AND holder_id = p_holder_id
     AND expires_at >= v_now;
  RETURN FOUND;
END;
$$;

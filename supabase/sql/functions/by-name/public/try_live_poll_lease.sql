-- Canonical SQL source for public.try_live_poll_lease.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.try_live_poll_lease(
  p_lock_key      bigint,
  p_ttl_seconds   integer DEFAULT 90
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now    timestamptz := now();
  v_holder uuid        := gen_random_uuid();
  v_ttl    interval    := make_interval(secs => GREATEST(p_ttl_seconds, 1));
BEGIN
  -- Atomic insert-or-take-over-if-expired. The WHERE clause on DO UPDATE
  -- guarantees we only win if the existing row's lease has already lapsed.
  INSERT INTO public.live_poll_leases (lock_key, holder_id, acquired_at, expires_at)
  VALUES (p_lock_key, v_holder, v_now, v_now + v_ttl)
  ON CONFLICT (lock_key) DO UPDATE
     SET holder_id   = EXCLUDED.holder_id,
         acquired_at = EXCLUDED.acquired_at,
         expires_at  = EXCLUDED.expires_at
   WHERE public.live_poll_leases.expires_at < v_now;

  -- If we successfully claimed/renewed, our holder_id will be present now.
  IF EXISTS (
    SELECT 1
      FROM public.live_poll_leases
     WHERE lock_key  = p_lock_key
       AND holder_id = v_holder
  ) THEN
    RETURN v_holder;
  END IF;

  RETURN NULL;
END;
$$;

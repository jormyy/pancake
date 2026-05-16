-- Live-poll TTL lease, robust against PostgREST/pgbouncer pool churn.
--
-- Finding (audit slice D, iter 11):
-- - public.try_live_poll_lock / release_live_poll_lock use pg_try_advisory_lock
--   with session scope. PostgREST proxies each RPC over a pooled backend, so
--   the acquire can land on one backend and the release on another. The
--   release silently no-ops on the wrong backend and the lock leaks on the
--   original backend until the connection resets.
--
-- Mitigation:
-- - Persist the lease in a table so it survives connection switches.
-- - Acquire/release happen via atomic single-statement RPCs. The acquirer
--   gets back a holder token (uuid); only the holder can clear the lease,
--   which prevents a slow client from stomping a newer holder on release.
-- - Stale leases auto-clear once expires_at < now(), so a crashed worker
--   self-heals after the TTL.

CREATE TABLE IF NOT EXISTS public.live_poll_leases (
  lock_key     bigint PRIMARY KEY,
  holder_id    uuid        NOT NULL,
  acquired_at  timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);

ALTER TABLE public.live_poll_leases ENABLE ROW LEVEL SECURITY;
-- No policies: only SECURITY DEFINER RPCs (running as table owner) may access.

-- Try to acquire (or reclaim if expired) the lease for `p_lock_key`.
-- Returns a holder token on success, NULL when another live holder owns it.
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

-- Release the lease iff the caller still holds it (no-op otherwise).
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

REVOKE ALL ON FUNCTION public.try_live_poll_lease(bigint, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.try_live_poll_lease(bigint, integer) FROM anon;
REVOKE ALL ON FUNCTION public.try_live_poll_lease(bigint, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.try_live_poll_lease(bigint, integer) TO service_role;

REVOKE ALL ON FUNCTION public.release_live_poll_lease(bigint, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_live_poll_lease(bigint, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.release_live_poll_lease(bigint, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.release_live_poll_lease(bigint, uuid) TO service_role;

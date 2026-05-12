-- Shared live-poll lease for Fastify poller and Supabase pg_cron/Edge poller.
--
-- Finding:
-- - P1-13: backend live polling and pg_cron Edge live-poll can run the same
--   stats/scores sync concurrently.

CREATE OR REPLACE FUNCTION public.try_live_poll_lock()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pg_try_advisory_lock(779001, 1);
$$;

CREATE OR REPLACE FUNCTION public.release_live_poll_lock()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pg_advisory_unlock(779001, 1);
$$;

REVOKE ALL ON FUNCTION public.try_live_poll_lock() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.try_live_poll_lock() FROM anon;
REVOKE ALL ON FUNCTION public.try_live_poll_lock() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.try_live_poll_lock() TO service_role;

REVOKE ALL ON FUNCTION public.release_live_poll_lock() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_live_poll_lock() FROM anon;
REVOKE ALL ON FUNCTION public.release_live_poll_lock() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.release_live_poll_lock() TO service_role;

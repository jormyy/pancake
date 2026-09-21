-- The live-poll advisory lock (20260512000005) was superseded by the TTL lease
-- (20260516000001): live-poll and sync-scores call try_live_poll_lease and
-- release_live_poll_lease, and nothing else references try_live_poll_lock.
DROP FUNCTION IF EXISTS public.try_live_poll_lock();

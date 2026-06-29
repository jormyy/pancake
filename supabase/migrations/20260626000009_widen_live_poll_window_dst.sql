-- ============================================================
-- DST-robust edge live-poll window
--
-- The edge cron schedules in 20260327000018 use fixed UTC hours chosen for EDT
-- (UTC-4). pg_cron does not track DST, and contrary to that file's comment, most
-- of the Oct–Apr regular season is actually EST (UTC-5, Nov→mid-March). In EST
-- the live-poll window '* 15-23,0-4 * * *' maps to 10:00 AM–11:59 PM ET, missing
-- the documented 12:00–12:59 AM ET slot when late West-coast games can still be
-- live. Widen the UTC window to also cover 05:00–05:59 UTC (= 12–12:59 AM ET in
-- EST). cron.schedule() upserts by job name, so this re-schedules in place.
--
-- This widens the Edge cron coverage so hosted polling does not depend on any
-- always-on process.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'nba-live-poll',
      '* 15-23,0-5 * * *',
      $job$SELECT invoke_edge_function('live-poll')$job$
    );
  END IF;
END $$;

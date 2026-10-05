-- Keep net._http_response compact, driven by the 2026-10-05 production Disk IO
-- budget warning.
--
-- pg_net's background worker inserts every response and purges it after its
-- 6 hour TTL, but on production (pg_net 0.19.5) those writes never reached the
-- table statistics: pg_stat_statements counted ~160k response inserts while the
-- table showed n_tup_ins 1,802, n_dead_tup 0, and no autovacuum since the
-- 2026-08-16 restart. Purged rows never became reusable, and the heap grew to
-- 178 MB for 792 live rows. reconcile_edge_invocations joins that table on
-- request id (pg_net only indexes created), so every 5 minute run read the whole
-- heap: ~10 s and ~22.8k buffers per run, three quarters of all database block
-- reads on record.
--
-- An hourly VACUUM makes purged rows reusable, truncates the expired tail once
-- live rows have moved into reused pages, and keeps planner statistics current.
-- Only its tail truncation takes a short lock, and it yields to waiters.
-- INDEX_CLEANUP ON matters on a bloated heap: one hour of turnover touches
-- under 2% of its pages, so VACUUM would skip index cleanup, leave dead line
-- pointers in the expired tail, and never truncate it. Without a one-off
-- VACUUM (FULL), the hourly job shrinks an already bloated table after one TTL
-- period plus one run.
-- VACUUM skips a table it may not maintain with only a WARNING, so the
-- migration fails instead of scheduling a silent no-op.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    IF NOT has_table_privilege('net._http_response', 'MAINTAIN') THEN
      RAISE EXCEPTION '% cannot VACUUM net._http_response; the pg-net-response-vacuum job would be a no-op', current_user;
    END IF;
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'pg-net-response-vacuum';
    PERFORM cron.schedule(
      'pg-net-response-vacuum',
      '17 * * * *',
      $job$VACUUM (ANALYZE, INDEX_CLEANUP ON) net._http_response$job$
    );
  END IF;
END $$;

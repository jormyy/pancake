-- Annual rookie draft board sync.
--
-- The sync-draft-order Edge Function is idempotent: it pulls the official NBA
-- draft board, marks that class as current rookies, clears stale
-- nba_draft_number values from prior classes, and verifies the resulting board.
-- Run after the daily player sync so Sleeper/CDN player rows are already fresh.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobname) FROM cron.job
      WHERE jobname IN (
        'nba-sync-draft-order-june',
        'nba-sync-draft-order-july'
      );
  END IF;
END;
$$;

-- Late June: draft usually lands in this window.
SELECT cron.schedule(
  'nba-sync-draft-order-june',
  '0 13 20-30 6 *',
  $$SELECT invoke_edge_function('sync-draft-order')$$
);

-- Early July: retry window for delayed official page/API publication.
SELECT cron.schedule(
  'nba-sync-draft-order-july',
  '0 13 1-15 7 *',
  $$SELECT invoke_edge_function('sync-draft-order')$$
);

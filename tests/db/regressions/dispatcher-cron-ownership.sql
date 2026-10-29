\set ON_ERROR_STOP on
BEGIN;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM cron.job WHERE active
    AND jobname NOT IN ('work-dispatcher','io-hint-drain','io-cron-history-retention')) THEN
    RAISE EXCEPTION 'BUG: public-read-retention bypasses the work dispatcher';
  END IF;
END;
$$;
ROLLBACK;

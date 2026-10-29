BEGIN;
DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='io-hint-drain'
    AND schedule='* * * * *' AND command LIKE '%private.flush_league_inventory_hints(1000)%' AND command LIKE '%pg_try_advisory_lock%' AND active) THEN
    RAISE EXCEPTION 'Inventory hints do not use the guarded minute shared drain';
  END IF;
END $$;
ROLLBACK;

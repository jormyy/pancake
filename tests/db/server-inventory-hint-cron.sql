BEGIN;
DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='league-inventory-hint-drain'
    AND schedule='30 seconds' AND command='SELECT private.flush_league_inventory_hints(1000)' AND active) THEN
    RAISE EXCEPTION 'Inventory hints do not use the thirty second drain';
  END IF;
END $$;
ROLLBACK;

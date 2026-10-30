-- Canonical SQL source for private.queue_matchup_forecast_expiry.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.queue_matchup_forecast_expiry()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  INSERT INTO private.matchup_forecast_expiries AS queued(matchup_id,available_at)
    VALUES(NEW.matchup_id,NEW.valid_until)
  ON CONFLICT(matchup_id) DO UPDATE SET available_at=EXCLUDED.available_at
    WHERE queued.available_at IS DISTINCT FROM EXCLUDED.available_at;
  RETURN NULL;
END;
$$;

-- Canonical SQL source for private.enforce_trade_lifecycle_status.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.enforce_trade_lifecycle_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
DECLARE
  v_status league_status;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('accepted'::trade_status, 'completed'::trade_status) THEN
    SELECT status
      INTO v_status
      FROM leagues
     WHERE id = NEW.league_id
     FOR SHARE;

    IF v_status IS NULL THEN
      RAISE EXCEPTION 'League not found.'
        USING ERRCODE = 'P0002';
    END IF;

    IF v_status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
      RAISE EXCEPTION 'Trades require an active or playoff season.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

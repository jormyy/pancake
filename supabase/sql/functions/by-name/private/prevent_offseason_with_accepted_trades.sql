-- Canonical SQL source for private.prevent_offseason_with_accepted_trades.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_offseason_with_accepted_trades()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
BEGIN
  IF NEW.status = 'offseason'::league_status
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM 1
      FROM trades
     WHERE league_id = NEW.id
       AND status = 'accepted'::trade_status
     LIMIT 1
     FOR UPDATE;

    IF FOUND THEN
      RAISE EXCEPTION 'Cannot move league to offseason while accepted trades are unresolved.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

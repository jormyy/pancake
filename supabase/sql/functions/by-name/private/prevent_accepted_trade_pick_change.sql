-- Canonical SQL source for private.prevent_accepted_trade_pick_change.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_accepted_trade_pick_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
BEGIN
  IF private.trade_lifecycle_write_active() THEN
    RETURN NEW;
  END IF;

  IF (
    OLD.current_owner_id IS DISTINCT FROM NEW.current_owner_id
    OR (NEW.is_used = true AND OLD.is_used IS DISTINCT FROM NEW.is_used)
  ) AND private.is_reserved_trade_asset(OLD.league_id, NULL, OLD.current_owner_id, NULL, OLD.id) THEN
    RAISE EXCEPTION 'This pick is reserved as an accepted trade asset.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

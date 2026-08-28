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

  IF private.pick_left_owner(OLD, NEW) IS NOT NULL THEN
    PERFORM private.assert_not_reserved_trade_asset(OLD.league_id, NULL, OLD.current_owner_id, NULL, OLD.id);
  END IF;

  RETURN NEW;
END;
$$;

-- Canonical SQL source for private.prevent_accepted_trade_pick_change.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_accepted_trade_pick_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM leagues WHERE id=OLD.league_id) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF private.trade_lifecycle_write_active() THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    PERFORM private.assert_not_reserved_trade_asset(OLD.league_id,NULL,OLD.current_owner_id,NULL,OLD.id);
    RETURN OLD;
  END IF;

  IF private.pick_left_owner(OLD, NEW) IS NOT NULL THEN
    PERFORM private.assert_not_reserved_trade_asset(OLD.league_id, NULL, OLD.current_owner_id, NULL, OLD.id);
  END IF;

  RETURN NEW;
END;
$$;

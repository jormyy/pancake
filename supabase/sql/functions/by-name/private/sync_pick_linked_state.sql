-- Canonical SQL source for private.sync_pick_linked_state.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.sync_pick_linked_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_consumed boolean := NEW.is_used = true AND OLD.is_used IS DISTINCT FROM NEW.is_used;
BEGIN
  IF NOT private.pick_left_owner(OLD, NEW) THEN
    RETURN NULL;
  END IF;

  DELETE FROM trade_block_items
   WHERE league_id = OLD.league_id
     AND pick_id = OLD.id
     AND (v_consumed OR member_id = OLD.current_owner_id);

  PERFORM private.expire_pending_trades_for_lost_asset(
    OLD.league_id,
    OLD.current_owner_id,
    NULL,
    OLD.id,
    v_consumed
  );

  RETURN NULL;
END;
$$;

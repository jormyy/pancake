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
  v_left text := private.pick_left_owner(OLD, NEW);
BEGIN
  IF v_left IS NULL THEN
    RETURN NULL;
  END IF;

  DELETE FROM trade_block_items
   WHERE league_id = OLD.league_id
     AND pick_id = OLD.id
     AND (v_left = 'used' OR member_id = OLD.current_owner_id);

  PERFORM private.expire_pending_trades_for_lost_asset(
    OLD.league_id,
    OLD.current_owner_id,
    NULL,
    OLD.id,
    v_left = 'used'
  );

  RETURN NULL;
END;
$$;

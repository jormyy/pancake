-- Canonical SQL source for private.sync_trade_block_on_pick_change.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.sync_trade_block_on_pick_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_changed boolean := OLD.current_owner_id IS DISTINCT FROM NEW.current_owner_id;
  v_consumed boolean := NEW.is_used = true AND OLD.is_used IS DISTINCT FROM NEW.is_used;
BEGIN
  IF NOT (v_owner_changed OR v_consumed) THEN
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
    CASE
      WHEN v_consumed THEN format('The %s round %s pick has been used in the draft.', OLD.season_year, OLD.round)
      ELSE NULL
    END
  );

  RETURN NULL;
END;
$$;

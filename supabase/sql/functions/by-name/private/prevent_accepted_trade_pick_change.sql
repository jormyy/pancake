-- Canonical SQL source for private.prevent_accepted_trade_pick_change.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_accepted_trade_pick_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
BEGIN
  -- Trade completion moves reserved picks itself and marks the transaction.
  IF current_setting('app.trade_lifecycle_server_write', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF (
    OLD.current_owner_id IS DISTINCT FROM NEW.current_owner_id
    OR (NEW.is_used = true AND OLD.is_used IS DISTINCT FROM NEW.is_used)
  ) AND EXISTS (
    SELECT 1
      FROM trade_items AS item
      JOIN trades AS trade
        ON trade.id = item.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE item.pick_id = OLD.id
       AND item.from_member_id = OLD.current_owner_id
  ) THEN
    RAISE EXCEPTION 'This pick is reserved as an accepted trade asset.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

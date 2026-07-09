-- Canonical SQL source for private.cleanup_trade_drop_reservations_on_terminal_trade.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.cleanup_trade_drop_reservations_on_terminal_trade()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
BEGIN
  IF OLD.status = 'accepted'::trade_status
     AND NEW.status <> 'accepted'::trade_status THEN
    DELETE FROM trade_drop_reservations
     WHERE trade_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

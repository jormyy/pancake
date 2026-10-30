-- Canonical SQL source for private.cancel_conflicting_trade_offers.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.cancel_conflicting_trade_offers()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status IN ('accepted','completed') AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM private.cancel_pending_trades_for_moved_assets(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

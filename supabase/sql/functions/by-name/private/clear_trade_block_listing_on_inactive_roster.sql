-- Canonical SQL source for private.clear_trade_block_listing_on_inactive_roster.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.clear_trade_block_listing_on_inactive_roster()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_on_ir = true OR NEW.is_on_taxi = true THEN
    PERFORM private.clear_trade_block_listing_for_asset(
      NEW.league_id,
      NEW.member_id,
      NEW.player_id
    );
  END IF;

  RETURN NEW;
END;
$$;

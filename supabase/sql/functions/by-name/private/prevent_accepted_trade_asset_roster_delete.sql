-- Canonical SQL source for private.prevent_accepted_trade_asset_roster_delete.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_accepted_trade_asset_roster_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
BEGIN
  PERFORM private.assert_not_reserved_trade_asset(OLD.league_id, OLD.league_season_id, OLD.member_id, OLD.player_id);

  RETURN OLD;
END;
$$;

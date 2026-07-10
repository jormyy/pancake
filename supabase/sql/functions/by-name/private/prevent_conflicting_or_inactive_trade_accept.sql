-- Canonical SQL source for private.prevent_conflicting_or_inactive_trade_accept.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_conflicting_or_inactive_trade_accept()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
BEGIN
  IF NEW.status = 'accepted'::trade_status AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM private.assert_trade_assets_acceptance_ready(
      NEW.id,
      NEW.league_id,
      NEW.league_season_id
    );
  END IF;

  RETURN NEW;
END;
$$;

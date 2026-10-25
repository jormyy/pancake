-- Canonical SQL source for private.prevent_uncleared_waiver_free_agent_add.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_uncleared_waiver_free_agent_add()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.acquired_via = 'free_agent' THEN
    PERFORM private.assert_free_agent_waiver_cleared(NEW.league_id, NEW.league_season_id, NEW.player_id);
  END IF;
  RETURN NEW;
END;
$$;

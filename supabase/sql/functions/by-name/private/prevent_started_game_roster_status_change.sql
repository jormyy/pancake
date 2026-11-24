-- Canonical SQL source for private.prevent_started_game_roster_status_change.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_started_game_roster_status_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF private.roster_status_game_started(NEW.player_id) THEN
    RAISE EXCEPTION 'This player''s game has already started. No roster status changes are allowed for that slate.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- Canonical SQL source for private.prevent_uncleared_waiver_free_agent_add.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_uncleared_waiver_free_agent_add()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.acquired_via = 'free_agent'
     AND EXISTS (
       SELECT 1
         FROM public.waiver_wire_log AS waiver
        WHERE waiver.league_id = NEW.league_id
          AND waiver.league_season_id = NEW.league_season_id
          AND waiver.player_id = NEW.player_id
          AND waiver.cleared_at IS NULL
     ) THEN
    RAISE EXCEPTION 'This player is on waivers - submit a waiver claim instead.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

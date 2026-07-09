-- Canonical SQL source for private.prevent_pending_waiver_inactive_drop.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_pending_waiver_inactive_drop()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
BEGIN
  IF NEW.drop_player_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM roster_players AS rp
     WHERE rp.league_id = NEW.league_id
       AND rp.league_season_id = NEW.league_season_id
       AND rp.member_id = NEW.member_id
       AND rp.player_id = NEW.drop_player_id
       AND rp.is_on_ir = false
       AND rp.is_on_taxi = false
  ) THEN
    RAISE EXCEPTION 'Waiver drop player must be on the active roster.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

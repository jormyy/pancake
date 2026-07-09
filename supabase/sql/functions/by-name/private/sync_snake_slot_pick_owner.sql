-- Canonical SQL source for private.sync_snake_slot_pick_owner.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.sync_snake_slot_pick_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
BEGIN
  IF NEW.current_owner_id IS DISTINCT FROM OLD.current_owner_id THEN
    UPDATE snake_draft_picks
       SET member_id = NEW.current_owner_id
     WHERE draft_pick_id = NEW.id
       AND player_id IS NULL;
  END IF;

  RETURN NEW;
END;
$$;

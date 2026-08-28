-- Canonical SQL source for private.pick_left_owner.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.pick_left_owner(
  p_old draft_picks,
  p_new draft_picks
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  -- A pick leaves its owner's hands when ownership changes or it is used in a draft.
  SELECT p_old.current_owner_id IS DISTINCT FROM p_new.current_owner_id
      OR (p_new.is_used = true AND p_old.is_used IS DISTINCT FROM p_new.is_used)
$$;

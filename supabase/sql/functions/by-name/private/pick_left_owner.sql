-- Canonical SQL source for private.pick_left_owner.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.pick_left_owner(
  p_old draft_picks,
  p_new draft_picks
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  -- How a pick left its owner's hands: 'used' in a draft, 'owner' when it
  -- changed hands, NULL when it did not leave.
  SELECT CASE
           WHEN p_new.is_used = true AND p_old.is_used IS DISTINCT FROM p_new.is_used THEN 'used'
           WHEN p_old.current_owner_id IS DISTINCT FROM p_new.current_owner_id THEN 'owner'
         END
$$;

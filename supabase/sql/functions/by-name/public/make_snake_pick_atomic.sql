-- Canonical SQL source for public.make_snake_pick_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.make_snake_pick_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_player_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN private.make_snake_pick_atomic_internal(
    p_draft_id,
    p_member_id,
    p_player_id,
    false
  );
END;
$$;

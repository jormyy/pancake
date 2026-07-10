-- Canonical SQL source for private.arm_next_snake_pick_timer.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.arm_next_snake_pick_timer(
  p_draft_id uuid,
  p_expires_at timestamptz
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_timer_expires_at timestamptz;
BEGIN
  UPDATE snake_draft_picks
     SET timer_expires_at = p_expires_at
   WHERE id = (
     SELECT id
       FROM snake_draft_picks
      WHERE draft_id = p_draft_id
        AND player_id IS NULL
        AND skipped_at IS NULL
      ORDER BY overall_pick
      LIMIT 1
   )
   RETURNING timer_expires_at INTO v_timer_expires_at;

  RETURN v_timer_expires_at;
END;
$$;

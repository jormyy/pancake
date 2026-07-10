-- Canonical SQL source for private.complete_rookie_draft_if_ready.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.complete_rookie_draft_if_ready(
  p_draft_id uuid,
  p_completed_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_remaining int;
  v_activated boolean := false;
BEGIN
  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.draft_type <> 'snake'::draft_type THEN
    RETURN jsonb_build_object('completed', false, 'activated', false);
  END IF;

  SELECT count(*)
    INTO v_remaining
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id IS NULL
     AND skipped_at IS NULL;

  IF v_remaining > 0 THEN
    RETURN jsonb_build_object('completed', false, 'activated', false);
  END IF;

  IF v_draft.status <> 'completed'::draft_status THEN
    UPDATE drafts
       SET status = 'completed',
           completed_at = p_completed_at,
           paused_at = NULL,
           timer_paused_remaining_seconds = NULL,
           pause_reason = NULL
     WHERE id = p_draft_id;
  END IF;

  v_activated := private.activate_rookie_draft_league_if_ready(p_draft_id);

  RETURN jsonb_build_object('completed', true, 'activated', v_activated);
END;
$$;

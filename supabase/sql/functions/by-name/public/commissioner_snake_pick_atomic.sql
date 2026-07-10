-- Canonical SQL source for public.commissioner_snake_pick_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.commissioner_snake_pick_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_actor_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

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
    RAISE EXCEPTION 'Commissioner pick is only available for snake drafts'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_draft.status <> 'paused'::draft_status
     OR v_draft.timer_expiry_behavior <> 'commissioner_pick'
     OR v_draft.pause_reason IS DISTINCT FROM 'timer_expired_commissioner_pick' THEN
    RAISE EXCEPTION 'Draft is not waiting for a commissioner pick'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE drafts
     SET status = 'in_progress',
         paused_at = NULL,
         timer_paused_remaining_seconds = NULL,
         pause_reason = NULL
   WHERE id = p_draft_id;

  v_result := public.make_snake_pick_atomic(p_draft_id, p_member_id, p_player_id);

  INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
  VALUES (
    p_draft_id,
    v_draft.league_id,
    p_actor_user_id,
    'commissioner_pick',
    jsonb_build_object(
      'memberId', p_member_id,
      'playerId', p_player_id,
      'pick', v_result->'pick'
    )
  );

  RETURN v_result;
END;
$$;

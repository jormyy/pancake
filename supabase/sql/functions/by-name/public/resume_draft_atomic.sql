-- Canonical SQL source for public.resume_draft_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.resume_draft_atomic(
  p_draft_id uuid,
  p_actor_user_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_remaining_seconds int;
BEGIN
  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found.';
  END IF;
  IF v_draft.status <> 'paused' THEN
    RAISE EXCEPTION 'Only a paused draft can be resumed.';
  END IF;
  IF v_draft.pause_reason = 'timer_expired_commissioner_pick' THEN
    RAISE EXCEPTION 'Draft is waiting for a commissioner pick.'
      USING ERRCODE = 'P0001';
  END IF;

  v_remaining_seconds := COALESCE(v_draft.timer_paused_remaining_seconds, v_draft.pick_timer_seconds, 30);

  IF v_draft.draft_type = 'auction' THEN
    UPDATE nominations
       SET countdown_expires_at = now() + make_interval(secs => v_remaining_seconds)
     WHERE draft_id = p_draft_id
       AND status = 'open';
  ELSE
    PERFORM private.arm_next_snake_pick_timer(
      p_draft_id,
      now() + make_interval(secs => v_remaining_seconds)
    );
  END IF;

  UPDATE drafts
     SET status = 'in_progress',
         paused_at = NULL,
         timer_paused_remaining_seconds = NULL,
         pause_reason = NULL
   WHERE id = p_draft_id;

  INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
  VALUES (
    p_draft_id,
    v_draft.league_id,
    p_actor_user_id,
    'resume',
    jsonb_build_object('previousStatus', v_draft.status, 'remainingSeconds', v_remaining_seconds, 'isMock', v_draft.is_mock)
  );
END;
$$;

-- Canonical SQL source for public.resume_draft_if_absent_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.resume_draft_if_absent_atomic(p_draft_id uuid, p_actor_user_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_draft      drafts%ROWTYPE;
  v_new_expiry timestamptz;
BEGIN
  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found.';
  END IF;

  -- Only resume member_absent pauses; leave manual/timer pauses alone
  IF v_draft.status <> 'paused' OR v_draft.pause_reason IS DISTINCT FROM 'member_absent' THEN
    RETURN;
  END IF;

  -- Restore countdown if there were seconds remaining
  IF v_draft.timer_paused_remaining_seconds IS NOT NULL
     AND v_draft.timer_paused_remaining_seconds > 0 THEN
    v_new_expiry := now() + (v_draft.timer_paused_remaining_seconds * interval '1 second');
    UPDATE nominations
       SET countdown_expires_at = v_new_expiry
     WHERE draft_id = p_draft_id
       AND status   = 'open';
  END IF;

  UPDATE drafts
     SET status                        = 'in_progress',
         paused_at                     = NULL,
         timer_paused_remaining_seconds = NULL,
         pause_reason                  = NULL
   WHERE id = p_draft_id;

  INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
  VALUES (
    p_draft_id,
    v_draft.league_id,
    p_actor_user_id,
    'resume',
    jsonb_build_object('reason', 'member_absent_rejoined')
  );
END;
$function$;

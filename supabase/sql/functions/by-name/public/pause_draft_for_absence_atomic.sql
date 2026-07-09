-- Canonical SQL source for public.pause_draft_for_absence_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.pause_draft_for_absence_atomic(p_draft_id uuid, p_actor_user_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_draft            drafts%ROWTYPE;
  v_remaining_seconds int;
BEGIN
  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found.';
  END IF;

  -- No-op: already paused for absence (multiple clients converge here)
  IF v_draft.status = 'paused' AND v_draft.pause_reason = 'member_absent' THEN
    RETURN;
  END IF;

  IF v_draft.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Only an in-progress draft can be paused.';
  END IF;

  IF v_draft.draft_type <> 'auction' THEN
    RAISE EXCEPTION 'Presence-pause only applies to auction drafts.';
  END IF;

  -- Freeze countdown and record remaining seconds
  SELECT GREATEST(CEIL(EXTRACT(EPOCH FROM (countdown_expires_at - now())))::int, 0)
    INTO v_remaining_seconds
    FROM nominations
   WHERE draft_id = p_draft_id
     AND status   = 'open'
     AND countdown_expires_at IS NOT NULL
   ORDER BY nominated_at DESC
   LIMIT 1
   FOR UPDATE;

  UPDATE nominations
     SET countdown_expires_at = NULL
   WHERE draft_id = p_draft_id
     AND status   = 'open';

  UPDATE drafts
     SET status                        = 'paused',
         paused_at                     = now(),
         timer_paused_remaining_seconds = v_remaining_seconds,
         pause_reason                  = 'member_absent'
   WHERE id = p_draft_id;

  INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
  VALUES (
    p_draft_id,
    v_draft.league_id,
    p_actor_user_id,
    'pause',
    jsonb_build_object('reason', 'member_absent', 'remainingSeconds', v_remaining_seconds)
  );
END;
$function$;

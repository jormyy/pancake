-- Presence-driven pause/resume for auction drafts.
-- Lets any draft participant (not just commissioner) pause/resume when
-- someone disconnects from the draft room.

-- Extend the pause_reason constraint to allow 'member_absent'.
ALTER TABLE public.drafts
  DROP CONSTRAINT IF EXISTS drafts_pause_reason_known;
ALTER TABLE public.drafts
  ADD CONSTRAINT drafts_pause_reason_known CHECK (
    pause_reason IS NULL OR pause_reason IN (
      'manual',
      'timer_expired_pause',
      'timer_expired_commissioner_pick',
      'member_absent'
    )
  );

-- Pause an in-progress auction draft because a member left the room.
-- No commissioner required — any draft participant can call this.
-- No-ops silently if already paused for the same reason (multiple clients race).
CREATE OR REPLACE FUNCTION public.pause_draft_for_absence_atomic(
  p_draft_id     uuid,
  p_actor_user_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

-- Resume a draft that was paused because a member was absent.
-- No-ops silently if the pause was for a different reason (e.g. manual pause
-- by commissioner) so that clients can call this optimistically on every
-- "all members present" presence sync.
CREATE OR REPLACE FUNCTION public.resume_draft_if_absent_atomic(
  p_draft_id     uuid,
  p_actor_user_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.pause_draft_for_absence_atomic(uuid, uuid)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resume_draft_if_absent_atomic(uuid, uuid)   FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.pause_draft_for_absence_atomic(uuid, uuid)  TO service_role;
GRANT  EXECUTE ON FUNCTION public.resume_draft_if_absent_atomic(uuid, uuid)   TO service_role;

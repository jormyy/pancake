-- Draft controls join reset and picks before taking row locks.
BEGIN;

CREATE OR REPLACE FUNCTION public.pause_draft_atomic(
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
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found.';
  END IF;
  IF v_draft.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Only an in-progress draft can be paused.';
  END IF;

  IF v_draft.draft_type = 'auction' THEN
    SELECT GREATEST(CEIL(EXTRACT(EPOCH FROM (countdown_expires_at - now())))::int, 0)
      INTO v_remaining_seconds
      FROM nominations
     WHERE draft_id = p_draft_id
       AND status = 'open'
       AND countdown_expires_at IS NOT NULL
     ORDER BY nominated_at DESC
     LIMIT 1
     FOR UPDATE;

    UPDATE nominations
       SET countdown_expires_at = NULL
     WHERE draft_id = p_draft_id
       AND status = 'open';
  ELSE
    SELECT GREATEST(CEIL(EXTRACT(EPOCH FROM (timer_expires_at - now())))::int, 0)
      INTO v_remaining_seconds
      FROM snake_draft_picks
     WHERE draft_id = p_draft_id
       AND player_id IS NULL
       AND skipped_at IS NULL
       AND timer_expires_at IS NOT NULL
     ORDER BY overall_pick
     LIMIT 1
     FOR UPDATE;

    UPDATE snake_draft_picks
       SET timer_expires_at = NULL
     WHERE draft_id = p_draft_id
       AND player_id IS NULL
       AND skipped_at IS NULL;
  END IF;

  UPDATE drafts
     SET status = 'paused',
         paused_at = now(),
         timer_paused_remaining_seconds = v_remaining_seconds,
         pause_reason = 'manual'
   WHERE id = p_draft_id;

  INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
  VALUES (
    p_draft_id,
    v_draft.league_id,
    p_actor_user_id,
    'pause',
    jsonb_build_object('previousStatus', v_draft.status, 'remainingSeconds', v_remaining_seconds, 'isMock', v_draft.is_mock)
  );
END;
$$;

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
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

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

CREATE OR REPLACE FUNCTION public.stop_draft_atomic(
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
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found.';
  END IF;
  IF v_draft.status NOT IN ('pending', 'in_progress', 'paused') THEN
    RAISE EXCEPTION 'Only a pending or active draft can be stopped.';
  END IF;

  UPDATE nominations
     SET status = 'no_bid',
         countdown_expires_at = NULL,
         closed_at = now()
   WHERE draft_id = p_draft_id
     AND status = 'open';

  UPDATE snake_draft_picks
     SET timer_expires_at = NULL
   WHERE draft_id = p_draft_id
     AND player_id IS NULL
     AND skipped_at IS NULL;

  UPDATE drafts
     SET status = 'cancelled',
         completed_at = now(),
         paused_at = NULL,
         timer_paused_remaining_seconds = NULL,
         pause_reason = NULL
   WHERE id = p_draft_id;

  IF NOT v_draft.is_mock THEN
    UPDATE leagues
       SET status = 'active'
     WHERE id = v_draft.league_id;
  END IF;

  INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
  VALUES (
    p_draft_id,
    v_draft.league_id,
    p_actor_user_id,
    'stop',
    jsonb_build_object('previousStatus', v_draft.status, 'draftType', v_draft.draft_type, 'isMock', v_draft.is_mock)
  );
END;
$$;

COMMIT;

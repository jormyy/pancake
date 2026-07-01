-- Prod had already recorded the draft lifecycle migrations before this column
-- existed, so this append-only migration replays the affected RPC bodies with
-- pause_reason writes. Keep fresh-rebuild edits in the earlier focused
-- migrations and mirror only deployed-history deltas here.

ALTER TABLE public.drafts
  ADD COLUMN IF NOT EXISTS pause_reason text;

ALTER TABLE public.drafts
  DROP CONSTRAINT IF EXISTS drafts_pause_reason_known;

ALTER TABLE public.drafts
  ADD CONSTRAINT drafts_pause_reason_known CHECK (
    pause_reason IS NULL OR pause_reason IN (
      'manual',
      'timer_expired_pause',
      'timer_expired_commissioner_pick'
    )
  );

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

CREATE OR REPLACE FUNCTION public.reset_draft_atomic(
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
  v_player_ids uuid[];
BEGIN
  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found.';
  END IF;
  IF v_draft.status NOT IN ('pending', 'in_progress', 'paused', 'completed', 'cancelled') THEN
    RAISE EXCEPTION 'Draft cannot be reset from status %.', v_draft.status;
  END IF;

  IF v_draft.draft_type = 'auction' THEN
    v_player_ids := ARRAY(
      SELECT player_id
        FROM nominations
       WHERE draft_id = p_draft_id
         AND status = 'sold'
         AND player_id IS NOT NULL
    );

    IF NOT v_draft.is_mock THEN
      DELETE FROM roster_players
       WHERE league_season_id = v_draft.league_season_id
         AND acquired_via = 'draft'
         AND player_id = ANY(v_player_ids);

      DELETE FROM roster_transactions
       WHERE league_season_id = v_draft.league_season_id
         AND related_nomination_id IN (
           SELECT id FROM nominations WHERE draft_id = p_draft_id
         );
    END IF;

    DELETE FROM bids
     WHERE nomination_id IN (SELECT id FROM nominations WHERE draft_id = p_draft_id);
    DELETE FROM nominations WHERE draft_id = p_draft_id;

    UPDATE draft_budgets
       SET remaining = initial_budget
     WHERE draft_id = p_draft_id;

  ELSE
    v_player_ids := ARRAY(
      SELECT player_id
        FROM snake_draft_picks
       WHERE draft_id = p_draft_id
         AND player_id IS NOT NULL
    );

    IF NOT v_draft.is_mock THEN
      DELETE FROM roster_players
       WHERE league_season_id = v_draft.league_season_id
         AND acquired_via = 'draft'
         AND player_id = ANY(v_player_ids);

      DELETE FROM roster_transactions
       WHERE league_season_id = v_draft.league_season_id
         AND transaction_type = 'draft_won'
         AND player_id = ANY(v_player_ids);

      UPDATE draft_picks
         SET is_used = false,
             used_at = NULL,
             rookie_draft_id = NULL
       WHERE rookie_draft_id = p_draft_id;
    END IF;

    UPDATE snake_draft_picks
       SET player_id = NULL,
           picked_at = NULL,
           skipped_at = NULL,
           skip_reason = NULL,
           timer_expires_at = NULL
     WHERE draft_id = p_draft_id;

    PERFORM private.arm_next_snake_pick_timer(
      p_draft_id,
      now() + make_interval(secs => v_draft.pick_timer_seconds)
    );
  END IF;

  UPDATE drafts
     SET status = 'in_progress',
         current_nomination_order = 1,
         completed_at = NULL,
         paused_at = NULL,
         timer_paused_remaining_seconds = NULL,
         pause_reason = NULL
   WHERE id = p_draft_id;

  IF NOT v_draft.is_mock THEN
    UPDATE leagues
       SET status = 'drafting'
     WHERE id = v_draft.league_id;
  END IF;

  INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
  VALUES (
    p_draft_id,
    v_draft.league_id,
    p_actor_user_id,
    'reset',
    jsonb_build_object(
      'previousStatus', v_draft.status,
      'draftType', v_draft.draft_type,
      'isMock', v_draft.is_mock,
      'playersRemoved', COALESCE(array_length(v_player_ids, 1), 0)
    )
  );
END;
$$;

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
  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found.';
  END IF;
  IF v_draft.status <> 'paused' THEN
    RAISE EXCEPTION 'Only a paused draft can be resumed.';
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

CREATE OR REPLACE FUNCTION public.process_expired_snake_picks_atomic(
  p_limit int DEFAULT 100
)
RETURNS TABLE (
  pick_id uuid,
  draft_id uuid,
  member_id uuid,
  player_id uuid,
  picked boolean,
  error_code text,
  error_message text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 100), 0), 500);
  v_pick record;
  v_draft drafts%ROWTYPE;
  v_player_id uuid;
  v_result jsonb;
  v_remaining int;
  v_rows int;
  v_now timestamptz;
BEGIN
  FOR v_pick IN
    SELECT
      pick.id AS pick_id,
      pick.draft_id,
      pick.member_id,
      pick.draft_pick_id,
      draft.league_id,
      draft.league_season_id,
      draft.is_mock,
      draft.timer_expiry_behavior
    FROM snake_draft_picks AS pick
    JOIN drafts AS draft
      ON draft.id = pick.draft_id
     AND draft.draft_type = 'snake'
     AND draft.status = 'in_progress'
   WHERE pick.player_id IS NULL
     AND pick.skipped_at IS NULL
     AND pick.timer_expires_at IS NOT NULL
     AND pick.timer_expires_at < now()
     AND NOT EXISTS (
       SELECT 1
         FROM snake_draft_picks AS earlier
        WHERE earlier.draft_id = pick.draft_id
          AND earlier.player_id IS NULL
          AND earlier.skipped_at IS NULL
          AND earlier.overall_pick < pick.overall_pick
     )
   ORDER BY pick.timer_expires_at, pick.overall_pick, pick.id
   LIMIT v_limit
   FOR UPDATE OF pick SKIP LOCKED
  LOOP
    BEGIN
      v_player_id := NULL;
      v_now := now();

      PERFORM pg_advisory_xact_lock(hashtext(v_pick.draft_id::text), 0);

      SELECT *
        INTO v_draft
        FROM drafts
       WHERE id = v_pick.draft_id
       FOR UPDATE;

      IF NOT FOUND OR v_draft.status <> 'in_progress'::draft_status THEN
        CONTINUE;
      END IF;

      IF v_draft.timer_expiry_behavior = 'skip_pick' THEN
        UPDATE snake_draft_picks AS pick
           SET skipped_at = v_now,
               skip_reason = 'timer_expired',
               timer_expires_at = NULL
         WHERE pick.id = v_pick.pick_id
           AND pick.player_id IS NULL
           AND pick.skipped_at IS NULL;

        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows <> 1 THEN
          RAISE EXCEPTION 'Expired snake pick was already resolved'
            USING ERRCODE = 'P0001';
        END IF;

        IF NOT v_draft.is_mock AND v_pick.draft_pick_id IS NOT NULL THEN
          UPDATE draft_picks
             SET is_used = true,
                 used_at = v_now,
                 rookie_draft_id = v_pick.draft_id
           WHERE id = v_pick.draft_pick_id
             AND is_used = false;

          GET DIAGNOSTICS v_rows = ROW_COUNT;
          IF v_rows <> 1 THEN
            RAISE EXCEPTION 'Draft-pick asset is no longer available for skipped pick'
              USING ERRCODE = 'P0001';
          END IF;
        END IF;

        INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
        VALUES (
          v_pick.draft_id,
          v_draft.league_id,
          NULL,
          'skip_pick',
          jsonb_build_object(
            'reason', 'timer_expired',
            'memberId', v_pick.member_id,
            'pickId', v_pick.pick_id,
            'behavior', v_draft.timer_expiry_behavior
          )
        );

        SELECT count(*)
          INTO v_remaining
          FROM snake_draft_picks AS pick
         WHERE pick.draft_id = v_pick.draft_id
           AND pick.player_id IS NULL
           AND pick.skipped_at IS NULL;

        IF v_remaining > 0 THEN
          PERFORM private.arm_next_snake_pick_timer(
            v_pick.draft_id,
            v_now + make_interval(secs => v_draft.pick_timer_seconds)
          );
        ELSE
          PERFORM private.complete_rookie_draft_if_ready(v_pick.draft_id, v_now);
        END IF;

        RETURN QUERY
        SELECT
          v_pick.pick_id,
          v_pick.draft_id,
          v_pick.member_id,
          NULL::uuid,
          false,
          NULL::text,
          NULL::text;

      ELSIF v_draft.timer_expiry_behavior IN ('pause_draft', 'commissioner_pick') THEN
        UPDATE snake_draft_picks AS pick
           SET timer_expires_at = NULL
         WHERE pick.id = v_pick.pick_id
           AND pick.player_id IS NULL
           AND pick.skipped_at IS NULL;

        UPDATE drafts
           SET status = 'paused',
               paused_at = v_now,
               timer_paused_remaining_seconds = NULL,
               pause_reason = CASE
                 WHEN v_draft.timer_expiry_behavior = 'commissioner_pick' THEN 'timer_expired_commissioner_pick'
                 ELSE 'timer_expired_pause'
               END
         WHERE id = v_pick.draft_id
           AND status = 'in_progress';

        INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
        VALUES (
          v_pick.draft_id,
          v_draft.league_id,
          NULL,
          CASE
            WHEN v_draft.timer_expiry_behavior = 'commissioner_pick' THEN 'timer_expired_commissioner_pick'
            ELSE 'timer_expired_pause'
          END,
          jsonb_build_object(
            'memberId', v_pick.member_id,
            'pickId', v_pick.pick_id,
            'behavior', v_draft.timer_expiry_behavior
          )
        );

        RETURN QUERY
        SELECT
          v_pick.pick_id,
          v_pick.draft_id,
          v_pick.member_id,
          NULL::uuid,
          false,
          NULL::text,
          NULL::text;

      ELSE
        v_result := public.auto_pick_snake_pick_atomic(v_pick.draft_id, v_pick.member_id, 'timer_expired');
        v_player_id := (v_result->>'player_id')::uuid;

        RETURN QUERY
        SELECT
          v_pick.pick_id,
          v_pick.draft_id,
          v_pick.member_id,
          v_player_id,
          true,
          NULL::text,
          NULL::text;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RETURN QUERY
      SELECT
        v_pick.pick_id,
        v_pick.draft_id,
        v_pick.member_id,
        v_player_id,
        false,
        SQLSTATE::text,
        SQLERRM::text;
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.commissioner_snake_pick_atomic(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stop_draft_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reset_draft_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pause_draft_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resume_draft_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.process_expired_snake_picks_atomic(int) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.commissioner_snake_pick_atomic(uuid, uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.stop_draft_atomic(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reset_draft_atomic(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pause_draft_atomic(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.resume_draft_atomic(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.process_expired_snake_picks_atomic(int) TO service_role;

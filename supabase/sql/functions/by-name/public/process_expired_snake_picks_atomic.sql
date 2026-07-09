-- Canonical SQL source for public.process_expired_snake_picks_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
  v_candidate record;
  v_pick snake_draft_picks%ROWTYPE;
  v_draft drafts%ROWTYPE;
  v_player_id uuid;
  v_result jsonb;
  v_remaining int;
  v_rows int;
  v_now timestamptz;
BEGIN
  FOR v_candidate IN
    SELECT
      pick.id AS pick_id,
      pick.draft_id,
      pick.member_id
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
  LOOP
    BEGIN
      v_player_id := NULL;
      v_now := now();

      IF NOT pg_try_advisory_xact_lock(hashtext(v_candidate.draft_id::text), 0) THEN
        CONTINUE;
      END IF;

      SELECT *
        INTO v_draft
        FROM drafts
       WHERE id = v_candidate.draft_id
       FOR UPDATE;

      IF NOT FOUND
         OR v_draft.status <> 'in_progress'::draft_status
         OR v_draft.draft_type <> 'snake'::draft_type THEN
        CONTINUE;
      END IF;

      SELECT pick.*
        INTO v_pick
        FROM snake_draft_picks AS pick
       WHERE pick.id = v_candidate.pick_id
         AND pick.draft_id = v_candidate.draft_id
         AND pick.player_id IS NULL
         AND pick.skipped_at IS NULL
         AND pick.timer_expires_at IS NOT NULL
         AND pick.timer_expires_at < v_now
         AND NOT EXISTS (
           SELECT 1
             FROM snake_draft_picks AS earlier
            WHERE earlier.draft_id = pick.draft_id
              AND earlier.player_id IS NULL
              AND earlier.skipped_at IS NULL
              AND earlier.overall_pick < pick.overall_pick
         )
       FOR UPDATE;

      IF NOT FOUND THEN
        CONTINUE;
      END IF;

      IF v_draft.timer_expiry_behavior = 'skip_pick' THEN
        UPDATE snake_draft_picks AS pick
           SET skipped_at = v_now,
               skip_reason = 'timer_expired',
               timer_expires_at = NULL
         WHERE pick.id = v_pick.id
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
             AND league_id = v_draft.league_id
             AND current_owner_id = v_pick.member_id
             AND round = v_pick.round
             AND is_used = false;

          GET DIAGNOSTICS v_rows = ROW_COUNT;
          IF v_rows <> 1 THEN
            RAISE EXCEPTION 'Draft-pick asset is no longer owned by the manager on the clock'
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
            'pickId', v_pick.id,
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
          v_pick.id,
          v_pick.draft_id,
          v_pick.member_id,
          NULL::uuid,
          false,
          NULL::text,
          NULL::text;

      ELSIF v_draft.timer_expiry_behavior IN ('pause_draft', 'commissioner_pick') THEN
        UPDATE snake_draft_picks AS pick
           SET timer_expires_at = NULL
         WHERE pick.id = v_pick.id
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
            'pickId', v_pick.id,
            'behavior', v_draft.timer_expiry_behavior
          )
        );

        RETURN QUERY
        SELECT
          v_pick.id,
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
          v_pick.id,
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
        v_candidate.pick_id,
        v_candidate.draft_id,
        v_candidate.member_id,
        v_player_id,
        false,
        SQLSTATE::text,
        SQLERRM::text;
    END;
  END LOOP;
END;
$$;

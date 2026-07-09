-- Canonical SQL source for public.start_mock_draft_room_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.start_mock_draft_room_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_user_id uuid
)
RETURNS public.drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft public.drafts%ROWTYPE;
  v_league public.leagues%ROWTYPE;
  v_participant_count int;
  v_budget int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT *
    INTO v_draft
    FROM public.drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND OR NOT v_draft.is_mock THEN
    RAISE EXCEPTION 'Mock draft room not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.status <> 'pending'::public.draft_status THEN
    RAISE EXCEPTION 'Only scheduled mock draft rooms can be started'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_draft.created_by_member_id IS DISTINCT FROM p_member_id THEN
    RAISE EXCEPTION 'Only the room creator can start this mock draft room'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL OR NOT EXISTS (
    SELECT 1
      FROM public.league_members AS lm
     WHERE lm.id = p_member_id
       AND lm.league_id = v_draft.league_id
       AND lm.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Not authorized to start this mock draft room'
      USING ERRCODE = '42501';
  END IF;

  IF v_draft.scheduled_at IS NOT NULL AND v_draft.scheduled_at > now() THEN
    RAISE EXCEPTION 'This mock draft room is scheduled for a later time'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*)
    INTO v_participant_count
    FROM public.draft_room_members
   WHERE draft_id = p_draft_id;

  IF v_participant_count < 2 THEN
    RAISE EXCEPTION 'Need at least 2 joined managers to start a mock draft room'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_league
    FROM public.leagues
   WHERE id = v_draft.league_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found' USING ERRCODE = 'P0002';
  END IF;

  DELETE FROM public.draft_orders WHERE draft_id = p_draft_id;
  DELETE FROM public.draft_budgets WHERE draft_id = p_draft_id;
  DELETE FROM public.snake_draft_picks WHERE draft_id = p_draft_id;

  INSERT INTO public.draft_orders (draft_id, member_id, position)
  SELECT p_draft_id, drm.member_id, row_number() OVER (ORDER BY drm.joined_at ASC, drm.member_id ASC)::int
    FROM public.draft_room_members AS drm
   WHERE drm.draft_id = p_draft_id
   ORDER BY drm.joined_at ASC, drm.member_id ASC;

  IF v_draft.draft_type = 'auction'::public.draft_type THEN
    v_budget := COALESCE(v_draft.budget_per_team, v_league.auction_budget);
    IF v_budget IS NULL OR v_budget <= 0 THEN
      RAISE EXCEPTION 'Auction budget must be a positive integer before starting a room.'
        USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.draft_budgets (draft_id, member_id, initial_budget, remaining)
    SELECT p_draft_id, drm.member_id, v_budget, v_budget
      FROM public.draft_room_members AS drm
     WHERE drm.draft_id = p_draft_id
     ORDER BY drm.joined_at ASC, drm.member_id ASC;
  ELSE
    WITH pick_slots AS (
      SELECT
        rounds.round,
        ordered.member_id,
        CASE
          WHEN rounds.round % 2 = 0 THEN v_participant_count - ordered.position + 1
          ELSE ordered.position
        END AS pick_in_round
      FROM generate_series(1, COALESCE(v_draft.rounds, 3)) AS rounds(round)
      CROSS JOIN public.draft_orders AS ordered
     WHERE ordered.draft_id = p_draft_id
    )
    INSERT INTO public.snake_draft_picks (
      draft_id,
      overall_pick,
      round,
      pick_in_round,
      member_id,
      draft_pick_id
    )
    SELECT
      p_draft_id,
      ((round - 1) * v_participant_count) + pick_in_round,
      round,
      pick_in_round,
      member_id,
      NULL
    FROM pick_slots
    ORDER BY round, pick_in_round;

    PERFORM private.arm_next_snake_pick_timer(
      p_draft_id,
      now() + make_interval(secs => COALESCE(v_draft.pick_timer_seconds, 30))
    );
  END IF;

  UPDATE public.drafts
     SET status = 'in_progress',
         started_at = now(),
         completed_at = NULL,
         current_nomination_order = 1,
         paused_at = NULL,
         timer_paused_remaining_seconds = NULL,
         pause_reason = NULL
   WHERE id = p_draft_id
  RETURNING * INTO v_draft;

  RETURN v_draft;
END;
$$;

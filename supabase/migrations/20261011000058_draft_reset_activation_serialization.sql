-- Keep current-season reset guards while sharing the draft lock prefix with picks.
BEGIN;

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
  v_current_season_id uuid;
BEGIN
  -- Serialize with picks before taking draft, league or season row locks.
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found.';
  END IF;

  -- Match season advancement's lock order before inspecting mutable context.
  PERFORM 1 FROM leagues WHERE id = v_draft.league_id FOR UPDATE;
  SELECT id INTO v_current_season_id
    FROM league_seasons
   WHERE league_id = v_draft.league_id AND is_current = true
   FOR UPDATE;
  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found.';
  END IF;
  IF NOT v_draft.is_mock AND v_draft.league_season_id IS DISTINCT FROM v_current_season_id THEN
    RAISE EXCEPTION 'Only current season drafts can be reset.';
  END IF;

  IF NOT v_draft.is_mock AND EXISTS (
    SELECT 1 FROM trades
     WHERE league_id = v_draft.league_id AND status = 'accepted'::trade_status
  ) THEN
    RAISE EXCEPTION 'Resolve accepted trades before resetting the draft.';
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

CREATE OR REPLACE FUNCTION public.activate_rookie_draft_league_atomic(
  p_draft_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
BEGIN
  -- Serialize with picks before taking draft, league or season row locks.
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

  IF v_draft.is_mock THEN
    RETURN false;
  END IF;

  IF auth.uid() IS NOT NULL AND NOT private.is_commissioner(v_draft.league_id) THEN
    RAISE EXCEPTION 'Only the league commissioner can activate this rookie draft league.'
      USING ERRCODE = '42501';
  END IF;

  RETURN private.activate_rookie_draft_league_if_ready(p_draft_id);
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
  -- Serialize with picks before taking draft, league or season row locks.
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

CREATE OR REPLACE FUNCTION private.activate_rookie_draft_league_if_ready(
  p_draft_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_current_season league_seasons%ROWTYPE;
  v_rows int;
  v_unfilled_picks int;
BEGIN
  -- Serialize with picks before taking draft, league or season row locks.
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

  IF v_draft.is_mock THEN
    RETURN false;
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_draft.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.draft_type <> 'snake'::draft_type OR v_draft.status <> 'completed'::draft_status THEN
    RETURN false;
  END IF;

  SELECT *
    INTO v_current_season
    FROM league_seasons
   WHERE league_id = v_draft.league_id
     AND is_current = true
   FOR UPDATE;

  IF NOT FOUND OR v_draft.league_season_id <> v_current_season.id THEN
    RETURN false;
  END IF;

  SELECT count(*)
    INTO v_unfilled_picks
    FROM snake_draft_picks
   WHERE draft_id = v_draft.id
     AND player_id IS NULL
     AND skipped_at IS NULL;

  IF v_unfilled_picks > 0 THEN
    RETURN false;
  END IF;

  PERFORM 1
    FROM drafts AS current_draft
   WHERE current_draft.league_id = v_draft.league_id
     AND current_draft.league_season_id = v_current_season.id
     AND current_draft.id <> v_draft.id
     AND current_draft.draft_type = 'snake'::draft_type
     AND current_draft.is_mock = false
     AND current_draft.status IN (
       'pending'::draft_status,
       'in_progress'::draft_status,
       'paused'::draft_status
     )
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    RETURN false;
  END IF;

  PERFORM 1
    FROM league_seasons AS season
    JOIN league_members AS member
      ON member.league_id = v_draft.league_id
    LEFT JOIN roster_players AS roster
      ON roster.league_id = v_draft.league_id
     AND roster.league_season_id = season.id
     AND roster.member_id = member.id
     AND roster.is_on_ir = false
     AND roster.is_on_taxi = false
   WHERE season.id = v_current_season.id
   GROUP BY member.id
  HAVING count(roster.id) > v_league.roster_size
   LIMIT 1;

  IF FOUND THEN
    RETURN false;
  END IF;

  UPDATE leagues
     SET status = 'active'
   WHERE id = v_draft.league_id
     AND status = 'drafting';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

COMMIT;

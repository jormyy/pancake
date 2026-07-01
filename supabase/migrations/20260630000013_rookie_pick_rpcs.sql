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

CREATE OR REPLACE FUNCTION public.make_snake_pick_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_player_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_next_pick snake_draft_picks%ROWTYPE;
  v_on_roster_id uuid;
  v_already_picked_id uuid;
  v_now timestamptz := now();
  v_remaining int;
  v_completed boolean := false;
  v_activated boolean := false;
  v_completion jsonb;
  v_rows int;
  v_next_timer_expires_at timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Draft is not in progress' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_draft.league_id::text),
    hashtext(p_player_id::text)
  );

  SELECT *
    INTO v_next_pick
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id IS NULL
     AND skipped_at IS NULL
   ORDER BY overall_pick
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No picks remaining - draft may be complete'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_next_pick.member_id <> p_member_id THEN
    RAISE EXCEPTION 'It''s not your pick'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_draft.is_mock AND v_next_pick.draft_pick_id IS NULL THEN
    RAISE EXCEPTION 'Draft slot is missing its draft-pick asset'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM players
   WHERE id = p_player_id
     AND years_exp = 0
     AND nba_draft_number IS NOT NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rookie draft picks must select a rookie-eligible player'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_draft.is_mock THEN
    SELECT id
      INTO v_on_roster_id
      FROM roster_players
     WHERE league_id = v_draft.league_id
       AND league_season_id = v_draft.league_season_id
       AND player_id = p_player_id
     FOR UPDATE;

    IF v_on_roster_id IS NOT NULL THEN
      RAISE EXCEPTION 'Player is already on a roster' USING ERRCODE = '23505';
    END IF;
  END IF;

  SELECT id
    INTO v_already_picked_id
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id = p_player_id
   LIMIT 1;

  IF v_already_picked_id IS NOT NULL THEN
    RAISE EXCEPTION 'Player already picked in this draft'
      USING ERRCODE = '23505';
  END IF;

  UPDATE snake_draft_picks
     SET player_id = p_player_id,
         picked_at = v_now,
         skipped_at = NULL,
         skip_reason = NULL,
         timer_expires_at = NULL
   WHERE id = v_next_pick.id
     AND player_id IS NULL
     AND skipped_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to record snake draft pick atomically'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_draft.is_mock THEN
    INSERT INTO roster_players (
      league_id,
      league_season_id,
      member_id,
      player_id,
      acquired_via
    )
    VALUES (
      v_draft.league_id,
      v_draft.league_season_id,
      p_member_id,
      p_player_id,
      'draft'
    );

    INSERT INTO roster_transactions (
      league_id,
      league_season_id,
      member_id,
      player_id,
      transaction_type,
      occurred_at
    )
    VALUES (
      v_draft.league_id,
      v_draft.league_season_id,
      p_member_id,
      p_player_id,
      'draft_won',
      v_now
    );

    UPDATE draft_picks
       SET is_used = true,
           used_at = v_now,
           rookie_draft_id = p_draft_id
     WHERE id = v_next_pick.draft_pick_id
       AND league_id = v_draft.league_id
       AND current_owner_id = p_member_id
       AND round = v_next_pick.round
       AND is_used = false;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Draft-pick asset is no longer owned by the manager on the clock'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT count(*)
    INTO v_remaining
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id IS NULL
     AND skipped_at IS NULL;

  IF v_remaining > 0 THEN
    v_next_timer_expires_at := private.arm_next_snake_pick_timer(
      p_draft_id,
      v_now + make_interval(secs => v_draft.pick_timer_seconds)
    );
  END IF;

  IF v_remaining = 0 THEN
    v_completion := private.complete_rookie_draft_if_ready(p_draft_id, v_now);
    v_completed := COALESCE((v_completion->>'completed')::boolean, false);
    v_activated := COALESCE((v_completion->>'activated')::boolean, false);
  END IF;

  RETURN jsonb_build_object(
    'pick', jsonb_build_object(
      'id', v_next_pick.id,
      'overall_pick', v_next_pick.overall_pick,
      'round', v_next_pick.round,
      'pick_in_round', v_next_pick.pick_in_round,
      'member_id', v_next_pick.member_id,
      'draft_pick_id', v_next_pick.draft_pick_id
    ),
    'player_id', p_player_id,
    'remaining', v_remaining,
    'completed', v_completed,
    'activated', v_activated,
    'league_id', v_draft.league_id,
    'league_season_id', v_draft.league_season_id,
    'is_mock', v_draft.is_mock,
    'next_timer_expires_at', v_next_timer_expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.auto_pick_snake_pick_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_reason text DEFAULT 'manual'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_player_id uuid;
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
    RAISE EXCEPTION 'Auto-pick is only available for snake drafts'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT player.id
    INTO v_player_id
    FROM players AS player
   WHERE player.years_exp = 0
     AND player.nba_draft_number IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM snake_draft_picks AS picked
        WHERE picked.draft_id = p_draft_id
          AND picked.player_id = player.id
     )
     AND (
       v_draft.is_mock OR NOT EXISTS (
         SELECT 1
           FROM roster_players AS roster
          WHERE roster.league_id = v_draft.league_id
            AND roster.league_season_id = v_draft.league_season_id
            AND roster.player_id = player.id
       )
     )
   ORDER BY player.nba_draft_number, player.id
   LIMIT 1;

  IF v_player_id IS NULL THEN
    RAISE EXCEPTION 'No available players for auto-pick'
      USING ERRCODE = 'P0001';
  END IF;

  v_result := public.make_snake_pick_atomic(p_draft_id, p_member_id, v_player_id);

  INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
  VALUES (
    p_draft_id,
    v_draft.league_id,
    NULL,
    'auto_pick',
    jsonb_build_object(
      'reason', COALESCE(NULLIF(trim(p_reason), ''), 'manual'),
      'source', 'nba_draft_number',
      'memberId', p_member_id,
      'playerId', v_player_id,
      'pick', v_result->'pick'
    )
  );

  RETURN v_result || jsonb_build_object('player_id', v_player_id);
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

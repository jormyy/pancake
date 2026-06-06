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
  v_rows int;
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

  IF v_next_pick.draft_pick_id IS NULL THEN
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
         picked_at = v_now
   WHERE id = v_next_pick.id
     AND player_id IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to record snake draft pick atomically'
      USING ERRCODE = 'P0001';
  END IF;

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

  SELECT count(*)
    INTO v_remaining
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id
     AND player_id IS NULL;

  IF v_remaining = 0 THEN
    UPDATE drafts
       SET status = 'completed',
           completed_at = v_now
     WHERE id = p_draft_id;

    v_completed := true;

    IF NOT EXISTS (
      SELECT 1
        FROM league_seasons AS season
        JOIN league_members AS member
          ON member.league_id = v_draft.league_id
        LEFT JOIN roster_players AS roster
          ON roster.league_id = v_draft.league_id
         AND roster.league_season_id = season.id
         AND roster.member_id = member.id
         AND roster.is_on_ir = false
         AND roster.is_on_taxi = false
       WHERE season.id = v_draft.league_season_id
       GROUP BY member.id
      HAVING count(roster.id) > (
        SELECT roster_size FROM leagues WHERE id = v_draft.league_id
      )
    ) THEN
      UPDATE leagues
         SET status = 'active'
       WHERE id = v_draft.league_id
         AND status = 'drafting';

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_activated := v_rows = 1;
    END IF;
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
    'remaining', v_remaining,
    'completed', v_completed,
    'activated', v_activated,
    'league_id', v_draft.league_id,
    'league_season_id', v_draft.league_season_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.make_snake_pick_atomic(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.make_snake_pick_atomic(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.make_snake_pick_atomic(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.make_snake_pick_atomic(uuid, uuid, uuid) TO service_role;

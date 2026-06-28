-- Lineup current-season and stat-sync hardening:
-- - Keep Edge stat sync from persisting stale past Scheduled box scores.
-- - Repair auction draft ordering to use league_members.joined_at.
-- - Prevent stale completed rookie drafts from activating later seasons.
-- - Prevent authenticated lineup RPCs from mutating non-current seasons.

CREATE OR REPLACE FUNCTION public.start_auction_draft_atomic(
  p_league_id uuid,
  p_nomination_order_mode text DEFAULT 'user_nominated'
)
RETURNS drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league leagues%ROWTYPE;
  v_season league_seasons%ROWTYPE;
  v_draft drafts%ROWTYPE;
  v_member_count int;
BEGIN
  IF p_nomination_order_mode NOT IN ('user_nominated', 'by_projection', 'alphabetical') THEN
    RAISE EXCEPTION 'Invalid nomination order mode: %', p_nomination_order_mode;
  END IF;

  SELECT * INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found';
  END IF;

  IF v_league.status IS DISTINCT FROM 'setup'::league_status THEN
    RAISE EXCEPTION 'Auction draft can only start while league is setup';
  END IF;

  IF v_league.auction_budget IS NULL OR v_league.auction_budget <= 0 THEN
    RAISE EXCEPTION 'Auction budget must be a positive integer before starting a draft.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_season
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season for this league';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM drafts
     WHERE league_id = p_league_id
       AND league_season_id = v_season.id
       AND draft_type = 'auction'
       AND status <> 'cancelled'::draft_status
  ) THEN
    RAISE EXCEPTION 'A draft already exists for this league season';
  END IF;

  SELECT count(*) INTO v_member_count
    FROM league_members
   WHERE league_id = p_league_id;
  IF v_member_count < 2 THEN
    RAISE EXCEPTION 'Need at least 2 managers to start a draft';
  END IF;

  INSERT INTO drafts (
    league_id,
    league_season_id,
    draft_type,
    status,
    budget_per_team,
    started_at,
    current_nomination_order,
    nomination_order_mode
  )
  VALUES (
    p_league_id,
    v_season.id,
    'auction',
    'in_progress',
    v_league.auction_budget,
    now(),
    1,
    p_nomination_order_mode
  )
  RETURNING * INTO v_draft;

  INSERT INTO draft_orders (draft_id, member_id, position)
  SELECT v_draft.id, lm.id, row_number() OVER (ORDER BY lm.joined_at ASC, lm.id ASC)::int
    FROM league_members lm
   WHERE lm.league_id = p_league_id
   ORDER BY lm.joined_at ASC, lm.id ASC;

  INSERT INTO draft_budgets (draft_id, member_id, initial_budget, remaining)
  SELECT v_draft.id, lm.id, v_league.auction_budget, v_league.auction_budget
    FROM league_members lm
   WHERE lm.league_id = p_league_id
   ORDER BY lm.joined_at ASC, lm.id ASC;

  UPDATE leagues
     SET status = 'drafting'
   WHERE id = p_league_id;

  RETURN v_draft;
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

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_draft.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF auth.uid() IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM league_members
     WHERE league_id = v_draft.league_id
       AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Only league members can activate this rookie draft league.'
      USING ERRCODE = 'P0001';
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
     AND player_id IS NULL;

  IF v_unfilled_picks > 0 THEN
    RETURN false;
  END IF;

  PERFORM 1
    FROM drafts AS current_draft
   WHERE current_draft.league_id = v_draft.league_id
     AND current_draft.league_season_id = v_current_season.id
     AND current_draft.id <> v_draft.id
     AND current_draft.draft_type = 'snake'::draft_type
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

CREATE OR REPLACE FUNCTION public.assert_current_league_season_for_lineup(
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM 1
    FROM league_seasons
   WHERE id = p_league_season_id
     AND league_id = p_league_id
     AND is_current = true
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lineup changes can only target the current league season.'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

ALTER FUNCTION public.set_player_slot_moves_atomic(uuid, uuid, uuid, date, int, jsonb)
  RENAME TO set_player_slot_moves_atomic_unchecked_legacy;

ALTER FUNCTION public.auto_set_lineup_atomic(uuid, uuid, uuid, date, jsonb)
  RENAME TO auto_set_lineup_atomic_unchecked_legacy;

CREATE OR REPLACE FUNCTION public.set_player_slot_moves_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_game_date date,
  p_week_number int,
  p_moves jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.assert_current_league_season_for_lineup(p_league_id, p_league_season_id);
  PERFORM public.set_player_slot_moves_atomic_unchecked_legacy(
    p_member_id,
    p_league_id,
    p_league_season_id,
    p_game_date,
    p_week_number,
    p_moves
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_player_slot_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_player_id uuid,
  p_game_date date,
  p_slot_type roster_slot_type,
  p_week_number int
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.set_player_slot_moves_atomic(
    p_member_id,
    p_league_id,
    p_league_season_id,
    p_game_date,
    p_week_number,
    jsonb_build_array(jsonb_build_object(
      'player_id', p_player_id,
      'slot_type', p_slot_type
    ))
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.auto_set_lineup_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_game_date date,
  p_assignments jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.assert_current_league_season_for_lineup(p_league_id, p_league_season_id);
  PERFORM public.auto_set_lineup_atomic_unchecked_legacy(
    p_member_id,
    p_league_id,
    p_league_season_id,
    p_game_date,
    p_assignments
  );
END;
$$;

REVOKE ALL ON FUNCTION public.start_auction_draft_atomic(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_auction_draft_atomic(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.start_auction_draft_atomic(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.start_auction_draft_atomic(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.activate_rookie_draft_league_atomic(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.activate_rookie_draft_league_atomic(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.activate_rookie_draft_league_atomic(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.activate_rookie_draft_league_atomic(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.activate_rookie_draft_league_atomic(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.assert_current_league_season_for_lineup(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_current_league_season_for_lineup(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.assert_current_league_season_for_lineup(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.assert_current_league_season_for_lineup(uuid, uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.set_player_slot_moves_atomic_unchecked_legacy(uuid, uuid, uuid, date, int, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_player_slot_moves_atomic_unchecked_legacy(uuid, uuid, uuid, date, int, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.set_player_slot_moves_atomic_unchecked_legacy(uuid, uuid, uuid, date, int, jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION public.set_player_slot_moves_atomic_unchecked_legacy(uuid, uuid, uuid, date, int, jsonb) FROM service_role;
REVOKE ALL ON FUNCTION public.auto_set_lineup_atomic_unchecked_legacy(uuid, uuid, uuid, date, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auto_set_lineup_atomic_unchecked_legacy(uuid, uuid, uuid, date, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.auto_set_lineup_atomic_unchecked_legacy(uuid, uuid, uuid, date, jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION public.auto_set_lineup_atomic_unchecked_legacy(uuid, uuid, uuid, date, jsonb) FROM service_role;

REVOKE ALL ON FUNCTION public.set_player_slot_moves_atomic(uuid, uuid, uuid, date, int, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_player_slot_moves_atomic(uuid, uuid, uuid, date, int, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.set_player_slot_atomic(uuid, uuid, uuid, uuid, date, roster_slot_type, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_player_slot_atomic(uuid, uuid, uuid, uuid, date, roster_slot_type, int) FROM anon;
REVOKE ALL ON FUNCTION public.auto_set_lineup_atomic(uuid, uuid, uuid, date, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auto_set_lineup_atomic(uuid, uuid, uuid, date, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_player_slot_moves_atomic(uuid, uuid, uuid, date, int, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_player_slot_atomic(uuid, uuid, uuid, uuid, date, roster_slot_type, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auto_set_lineup_atomic(uuid, uuid, uuid, date, jsonb) TO authenticated, service_role;

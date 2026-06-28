-- Roster ownership history hardening:
-- Ensure max-possible scoring can replay ownership for carried-over and
-- rookie-drafted players after later same-week drops/trades remove roster rows.

CREATE OR REPLACE FUNCTION public.advance_season_atomic(p_league_id uuid)
RETURNS TABLE(new_season_id uuid, new_year int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $advance_season_atomic$
DECLARE
  v_league leagues%ROWTYPE;
  v_current_season league_seasons%ROWTYPE;
  v_new_season_id uuid;
  v_new_year int;
  v_far_year int;
BEGIN
  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found';
  END IF;

  IF v_league.status NOT IN ('playoffs'::league_status, 'archived'::league_status) THEN
    RAISE EXCEPTION 'League must be in playoffs or archived state before advancing season.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_current_season
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season found for this league';
  END IF;

  v_new_year := v_current_season.season_year + 1;
  v_far_year := v_new_year + 5;

  IF EXISTS (
    SELECT 1
      FROM league_seasons
     WHERE league_id = p_league_id
       AND season_year = v_new_year
  ) THEN
    RAISE EXCEPTION 'Season % already exists', v_new_year;
  END IF;

  UPDATE league_seasons
     SET is_current = false
   WHERE id = v_current_season.id;

  INSERT INTO league_seasons (league_id, season_year, is_current)
  VALUES (p_league_id, v_new_year, true)
  RETURNING id INTO v_new_season_id;

  INSERT INTO roster_players (
    league_id,
    league_season_id,
    member_id,
    player_id,
    is_on_ir,
    is_on_taxi,
    acquired_via
  )
  SELECT
    p_league_id,
    v_new_season_id,
    member_id,
    player_id,
    is_on_ir,
    is_on_taxi,
    'carry_over'
  FROM roster_players
  WHERE league_id = p_league_id
    AND league_season_id = v_current_season.id;

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type,
    occurred_at
  )
  SELECT
    league_id,
    league_season_id,
    member_id,
    player_id,
    'carry_over',
    acquired_at
  FROM roster_players
  WHERE league_id = p_league_id
    AND league_season_id = v_new_season_id
    AND acquired_via = 'carry_over';

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type,
    occurred_at
  )
  SELECT
    league_id,
    league_season_id,
    member_id,
    player_id,
    CASE WHEN is_on_ir THEN 'ir_designate' ELSE 'taxi_designate' END,
    acquired_at + interval '1 millisecond'
  FROM roster_players
  WHERE league_id = p_league_id
    AND league_season_id = v_new_season_id
    AND acquired_via = 'carry_over'
    AND (is_on_ir = true OR is_on_taxi = true);

  INSERT INTO draft_picks (
    league_id,
    season_year,
    round,
    original_owner_id,
    current_owner_id
  )
  SELECT
    p_league_id,
    v_far_year,
    round_value,
    lm.id,
    lm.id
  FROM league_members lm
  CROSS JOIN unnest(ARRAY[1, 2, 3]) AS round_value
  WHERE lm.league_id = p_league_id
  ON CONFLICT (league_id, season_year, round, original_owner_id) DO NOTHING;

  INSERT INTO waiver_priorities (
    league_id,
    league_season_id,
    member_id,
    priority
  )
  WITH latest_standings AS (
    SELECT DISTINCT ON (member_id)
      member_id,
      wins,
      losses,
      points_for,
      points_against
    FROM standings
    WHERE league_id = p_league_id
      AND league_season_id = v_current_season.id
    ORDER BY member_id, week_number DESC
  ),
  ordered_members AS (
    SELECT
      lm.id AS member_id,
      row_number() OVER (
        ORDER BY
          COALESCE(ls.wins, 0) ASC,
          COALESCE(ls.points_for, 0) ASC,
          COALESCE(ls.losses, 0) DESC,
          COALESCE(ls.points_against, 0) DESC,
          lm.id ASC
      ) AS priority
    FROM league_members lm
    LEFT JOIN latest_standings ls ON ls.member_id = lm.id
    WHERE lm.league_id = p_league_id
  )
  SELECT p_league_id, v_new_season_id, member_id, priority
  FROM ordered_members;

  UPDATE leagues
     SET status = 'offseason'
   WHERE id = p_league_id;

  new_season_id := v_new_season_id;
  new_year := v_new_year;
  RETURN NEXT;
END;
$advance_season_atomic$;

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

INSERT INTO roster_transactions (
  league_id,
  league_season_id,
  member_id,
  player_id,
  transaction_type,
  occurred_at
)
SELECT
  rp.league_id,
  rp.league_season_id,
  rp.member_id,
  rp.player_id,
  'carry_over',
  COALESCE(rp.acquired_at, now())
FROM roster_players AS rp
JOIN league_seasons AS season
  ON season.id = rp.league_season_id
 AND season.is_current = true
WHERE rp.acquired_via = 'carry_over'
  AND NOT EXISTS (
    SELECT 1
      FROM roster_transactions AS rt
     WHERE rt.league_id = rp.league_id
       AND rt.league_season_id = rp.league_season_id
       AND rt.member_id = rp.member_id
       AND rt.player_id = rp.player_id
       AND rt.transaction_type = 'carry_over'
  );

INSERT INTO roster_transactions (
  league_id,
  league_season_id,
  member_id,
  player_id,
  transaction_type,
  occurred_at
)
SELECT
  rp.league_id,
  rp.league_season_id,
  rp.member_id,
  rp.player_id,
  CASE WHEN rp.is_on_ir THEN 'ir_designate' ELSE 'taxi_designate' END,
  COALESCE(rp.acquired_at, now()) + interval '1 millisecond'
FROM roster_players AS rp
JOIN league_seasons AS season
  ON season.id = rp.league_season_id
 AND season.is_current = true
WHERE rp.acquired_via = 'carry_over'
  AND (rp.is_on_ir = true OR rp.is_on_taxi = true)
  AND NOT EXISTS (
    SELECT 1
      FROM roster_transactions AS rt
     WHERE rt.league_id = rp.league_id
       AND rt.league_season_id = rp.league_season_id
       AND rt.member_id = rp.member_id
       AND rt.player_id = rp.player_id
       AND rt.transaction_type = CASE WHEN rp.is_on_ir THEN 'ir_designate' ELSE 'taxi_designate' END
  );

INSERT INTO roster_transactions (
  league_id,
  league_season_id,
  member_id,
  player_id,
  transaction_type,
  occurred_at
)
SELECT
  rp.league_id,
  rp.league_season_id,
  rp.member_id,
  rp.player_id,
  'draft_won',
  COALESCE(rp.acquired_at, now())
FROM roster_players AS rp
JOIN league_seasons AS season
  ON season.id = rp.league_season_id
 AND season.is_current = true
WHERE rp.acquired_via = 'draft'
  AND NOT EXISTS (
    SELECT 1
      FROM roster_transactions AS rt
     WHERE rt.league_id = rp.league_id
       AND rt.league_season_id = rp.league_season_id
       AND rt.member_id = rp.member_id
       AND rt.player_id = rp.player_id
       AND rt.transaction_type = 'draft_won'
  );

INSERT INTO roster_transactions (
  league_id,
  league_season_id,
  member_id,
  player_id,
  transaction_type,
  occurred_at
)
SELECT
  draft.league_id,
  draft.league_season_id,
  pick.member_id,
  pick.player_id,
  'draft_won',
  COALESCE(pick.picked_at, draft.started_at, draft.created_at, now())
FROM snake_draft_picks AS pick
JOIN drafts AS draft ON draft.id = pick.draft_id
WHERE pick.player_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM roster_transactions AS rt
     WHERE rt.league_id = draft.league_id
       AND rt.league_season_id = draft.league_season_id
       AND rt.member_id = pick.member_id
       AND rt.player_id = pick.player_id
       AND rt.transaction_type = 'draft_won'
  );

REVOKE ALL ON FUNCTION public.advance_season_atomic(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.advance_season_atomic(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.advance_season_atomic(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.advance_season_atomic(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.make_snake_pick_atomic(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.make_snake_pick_atomic(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.make_snake_pick_atomic(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.make_snake_pick_atomic(uuid, uuid, uuid) TO service_role;

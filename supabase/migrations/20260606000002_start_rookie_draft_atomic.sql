CREATE OR REPLACE FUNCTION public.start_rookie_draft_atomic(
  p_league_id uuid,
  p_rounds int DEFAULT 3
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league leagues%ROWTYPE;
  v_season league_seasons%ROWTYPE;
  v_last_season_id uuid;
  v_draft drafts%ROWTYPE;
  v_member_count int;
  v_order_count int;
  v_pick_count int;
BEGIN
  IF p_rounds < 1 THEN
    RAISE EXCEPTION 'Rookie draft must have at least one round.';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found';
  END IF;

  IF v_league.status <> 'offseason' THEN
    RAISE EXCEPTION 'League must be in offseason to start rookie draft';
  END IF;

  SELECT *
    INTO v_season
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season for this league';
  END IF;

  PERFORM 1
    FROM drafts
   WHERE league_id = p_league_id
     AND league_season_id = v_season.id
     AND draft_type = 'snake'
     AND status IN ('pending', 'in_progress')
   FOR UPDATE;

  IF FOUND THEN
    RAISE EXCEPTION 'A rookie draft already exists for this season';
  END IF;

  SELECT count(*)
    INTO v_member_count
    FROM league_members
   WHERE league_id = p_league_id;

  IF v_member_count < 2 THEN
    RAISE EXCEPTION 'Need at least 2 managers to start a draft';
  END IF;

  SELECT id
    INTO v_last_season_id
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = false
   ORDER BY season_year DESC
   LIMIT 1;

  CREATE TEMP TABLE pg_temp.rookie_draft_order (
    member_id uuid PRIMARY KEY,
    position int NOT NULL
  ) ON COMMIT DROP;

  INSERT INTO pg_temp.rookie_draft_order (member_id, position)
  SELECT member_id, row_number() OVER (
    ORDER BY
      has_standings DESC,
      wins ASC,
      points_for ASC,
      random_order ASC
  )::int
  FROM (
    SELECT
      lm.id AS member_id,
      CASE WHEN latest.member_id IS NULL THEN 0 ELSE 1 END AS has_standings,
      COALESCE(latest.wins, 0) AS wins,
      COALESCE(latest.points_for, 0) AS points_for,
      random() AS random_order
    FROM league_members AS lm
    LEFT JOIN LATERAL (
      SELECT s.member_id, s.wins, s.points_for
        FROM standings AS s
       WHERE v_last_season_id IS NOT NULL
         AND s.league_id = p_league_id
         AND s.league_season_id = v_last_season_id
         AND s.member_id = lm.id
       ORDER BY s.week_number DESC
       LIMIT 1
    ) AS latest ON true
    WHERE lm.league_id = p_league_id
  ) AS ordered;

  SELECT count(*) INTO v_order_count FROM pg_temp.rookie_draft_order;
  IF v_order_count < 2 THEN
    RAISE EXCEPTION 'Need at least 2 managers to start a draft';
  END IF;
  IF v_order_count <> v_member_count THEN
    RAISE EXCEPTION 'Failed to build a complete rookie draft order';
  END IF;

  INSERT INTO drafts (
    league_id,
    league_season_id,
    draft_type,
    status,
    started_at
  )
  VALUES (
    p_league_id,
    v_season.id,
    'snake',
    'in_progress',
    now()
  )
  RETURNING * INTO v_draft;

  INSERT INTO draft_orders (draft_id, member_id, position)
  SELECT v_draft.id, member_id, position
    FROM pg_temp.rookie_draft_order
   ORDER BY position;

  WITH pick_slots AS (
    SELECT
      rounds.round,
      ordered.member_id AS original_owner_id,
      CASE
        WHEN rounds.round % 2 = 0 THEN v_order_count - ordered.position + 1
        ELSE ordered.position
      END AS pick_in_round
    FROM generate_series(1, p_rounds) AS rounds(round)
    CROSS JOIN pg_temp.rookie_draft_order AS ordered
  ),
  resolved AS (
    SELECT
      pick_slots.round,
      pick_slots.pick_in_round,
      pick_slots.original_owner_id,
      dp.id AS draft_pick_id,
      dp.current_owner_id AS member_id
    FROM pick_slots
    JOIN LATERAL (
      SELECT id, current_owner_id
        FROM draft_picks
       WHERE league_id = p_league_id
         AND season_year = v_season.season_year
         AND round = pick_slots.round
         AND original_owner_id = pick_slots.original_owner_id
         AND is_used = false
       ORDER BY id
       LIMIT 1
       FOR UPDATE
    ) AS dp ON true
  )
  INSERT INTO snake_draft_picks (
    draft_id,
    overall_pick,
    round,
    pick_in_round,
    member_id,
    draft_pick_id
  )
  SELECT
    v_draft.id,
    ((round - 1) * v_order_count) + pick_in_round,
    round,
    pick_in_round,
    member_id,
    draft_pick_id
  FROM resolved
  ORDER BY round, pick_in_round;

  GET DIAGNOSTICS v_pick_count = ROW_COUNT;
  IF v_pick_count <> v_order_count * p_rounds THEN
    RAISE EXCEPTION 'Failed to create every rookie draft pick slot';
  END IF;

  UPDATE leagues
     SET status = 'drafting'
   WHERE id = p_league_id
     AND status = 'offseason';

  GET DIAGNOSTICS v_pick_count = ROW_COUNT;
  IF v_pick_count <> 1 THEN
    RAISE EXCEPTION 'Failed to mark league as drafting';
  END IF;

  RETURN to_jsonb(v_draft);
END;
$$;

REVOKE ALL ON FUNCTION public.start_rookie_draft_atomic(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_rookie_draft_atomic(uuid, int) FROM anon;
REVOKE ALL ON FUNCTION public.start_rookie_draft_atomic(uuid, int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.start_rookie_draft_atomic(uuid, int) TO service_role;

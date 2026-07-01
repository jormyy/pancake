DROP FUNCTION IF EXISTS public.start_auction_draft_atomic(uuid, text, boolean, int, int);

CREATE OR REPLACE FUNCTION public.start_auction_draft_atomic(
  p_league_id uuid,
  p_nomination_order_mode text DEFAULT 'user_nominated',
  p_is_mock boolean DEFAULT false,
  p_pick_timer_seconds int DEFAULT 30,
  p_budget_per_team int DEFAULT NULL,
  p_timer_expiry_behavior text DEFAULT 'auction_no_bid'
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
  v_budget int;
  v_is_mock boolean := COALESCE(p_is_mock, false);
BEGIN
  IF p_nomination_order_mode NOT IN ('user_nominated', 'by_projection', 'alphabetical') THEN
    RAISE EXCEPTION 'Invalid nomination order mode: %', p_nomination_order_mode;
  END IF;
  IF p_pick_timer_seconds IS NULL OR p_pick_timer_seconds < 5 OR p_pick_timer_seconds > 3600 THEN
    RAISE EXCEPTION 'Draft timer seconds must be between 5 and 3600.'
      USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(p_timer_expiry_behavior, 'auction_no_bid') <> 'auction_no_bid' THEN
    RAISE EXCEPTION 'Auction drafts use auction_no_bid timeout behavior.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found';
  END IF;

  IF NOT v_is_mock AND v_league.status IS DISTINCT FROM 'setup'::league_status THEN
    RAISE EXCEPTION 'Auction draft can only start while league is setup';
  END IF;

  v_budget := COALESCE(p_budget_per_team, v_league.auction_budget);
  IF v_budget IS NULL OR v_budget <= 0 THEN
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

  IF NOT v_is_mock AND EXISTS (
    SELECT 1
      FROM drafts
     WHERE league_id = p_league_id
       AND league_season_id = v_season.id
       AND draft_type = 'auction'
       AND is_mock = false
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
    nomination_order_mode,
    is_mock,
    pick_timer_seconds,
    timer_expiry_behavior
  )
  VALUES (
    p_league_id,
    v_season.id,
    'auction',
    'in_progress',
    v_budget,
    now(),
    1,
    p_nomination_order_mode,
    v_is_mock,
    p_pick_timer_seconds,
    'auction_no_bid'
  )
  RETURNING * INTO v_draft;

  INSERT INTO draft_orders (draft_id, member_id, position)
  SELECT v_draft.id, lm.id, row_number() OVER (ORDER BY lm.joined_at ASC, lm.id ASC)::int
    FROM league_members lm
   WHERE lm.league_id = p_league_id
   ORDER BY lm.joined_at ASC, lm.id ASC;

  INSERT INTO draft_budgets (draft_id, member_id, initial_budget, remaining)
  SELECT v_draft.id, lm.id, v_budget, v_budget
    FROM league_members lm
   WHERE lm.league_id = p_league_id
   ORDER BY lm.joined_at ASC, lm.id ASC;

  IF NOT v_is_mock THEN
    UPDATE leagues
       SET status = 'drafting'
     WHERE id = p_league_id;
  END IF;

  RETURN v_draft;
END;
$$;

DROP FUNCTION IF EXISTS public.start_rookie_draft_atomic(uuid, int);
DROP FUNCTION IF EXISTS public.start_rookie_draft_atomic(uuid, int, boolean, int);

CREATE OR REPLACE FUNCTION public.start_rookie_draft_atomic(
  p_league_id uuid,
  p_rounds int DEFAULT 3,
  p_is_mock boolean DEFAULT false,
  p_pick_timer_seconds int DEFAULT 30,
  p_timer_expiry_behavior text DEFAULT 'auto_pick'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league leagues%ROWTYPE;
  v_season league_seasons%ROWTYPE;
  v_draft drafts%ROWTYPE;
  v_member_count int;
  v_order_count int;
  v_last_season_id uuid;
  v_pick_count int;
  v_is_mock boolean := COALESCE(p_is_mock, false);
  v_timer_expiry_behavior text := COALESCE(p_timer_expiry_behavior, 'auto_pick');
BEGIN
  IF p_rounds < 1 OR p_rounds > 10 THEN
    RAISE EXCEPTION 'Rookie draft rounds must be between 1 and 10.';
  END IF;
  IF p_pick_timer_seconds IS NULL OR p_pick_timer_seconds < 5 OR p_pick_timer_seconds > 3600 THEN
    RAISE EXCEPTION 'Draft timer seconds must be between 5 and 3600.'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_timer_expiry_behavior NOT IN ('auto_pick', 'skip_pick', 'pause_draft', 'commissioner_pick') THEN
    RAISE EXCEPTION 'Invalid rookie draft timeout behavior: %', v_timer_expiry_behavior
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found';
  END IF;

  IF NOT v_is_mock AND v_league.status <> 'offseason' THEN
    RAISE EXCEPTION 'League must be in offseason to start rookie draft';
  END IF;

  SELECT * INTO v_season
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season for this league';
  END IF;

  IF NOT v_is_mock THEN
    PERFORM 1
      FROM drafts
     WHERE league_id = p_league_id
       AND league_season_id = v_season.id
       AND draft_type = 'snake'
       AND is_mock = false
       AND status IN ('pending', 'in_progress', 'paused')
     FOR UPDATE;

    IF FOUND THEN
      RAISE EXCEPTION 'A rookie draft already exists for this season';
    END IF;
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

  INSERT INTO drafts (
    league_id,
    league_season_id,
    draft_type,
    status,
    started_at,
    is_mock,
    pick_timer_seconds,
    rounds,
    timer_expiry_behavior
  )
  VALUES (
    p_league_id,
    v_season.id,
    'snake',
    'in_progress',
    now(),
    v_is_mock,
    p_pick_timer_seconds,
    p_rounds,
    v_timer_expiry_behavior
  )
  RETURNING * INTO v_draft;

  WITH ordered_members AS (
    SELECT
      lm.id AS member_id,
      CASE WHEN latest.member_id IS NULL THEN 0 ELSE 1 END AS has_standings,
      COALESCE(latest.wins, 0) AS wins,
      COALESCE(latest.points_for, 0) AS points_for
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
  ),
  rookie_draft_order AS (
    SELECT
      member_id,
      row_number() OVER (
        ORDER BY
          has_standings DESC,
          wins ASC,
          points_for ASC,
          member_id ASC
      )::int AS position
    FROM ordered_members
  )
  INSERT INTO draft_orders (draft_id, member_id, position)
  SELECT v_draft.id, member_id, position
    FROM rookie_draft_order
   ORDER BY position;

  GET DIAGNOSTICS v_order_count = ROW_COUNT;
  IF v_order_count < 2 THEN
    RAISE EXCEPTION 'Need at least 2 managers to start a draft';
  END IF;
  IF v_order_count <> v_member_count THEN
    RAISE EXCEPTION 'Failed to build a complete rookie draft order';
  END IF;

  IF v_is_mock THEN
    WITH pick_slots AS (
      SELECT
        rounds.round,
        ordered.member_id,
        CASE
          WHEN rounds.round % 2 = 0 THEN v_order_count - ordered.position + 1
          ELSE ordered.position
        END AS pick_in_round
      FROM generate_series(1, p_rounds) AS rounds(round)
      CROSS JOIN draft_orders AS ordered
     WHERE ordered.draft_id = v_draft.id
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
      NULL
    FROM pick_slots
    ORDER BY round, pick_in_round;
  ELSE
    WITH pick_slots AS (
      SELECT
        rounds.round,
        ordered.member_id AS original_owner_id,
        CASE
          WHEN rounds.round % 2 = 0 THEN v_order_count - ordered.position + 1
          ELSE ordered.position
        END AS pick_in_round
      FROM generate_series(1, p_rounds) AS rounds(round)
      CROSS JOIN draft_orders AS ordered
     WHERE ordered.draft_id = v_draft.id
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
  END IF;

  GET DIAGNOSTICS v_pick_count = ROW_COUNT;
  IF v_pick_count <> v_order_count * p_rounds THEN
    RAISE EXCEPTION 'Failed to create every rookie draft pick slot';
  END IF;

  PERFORM private.arm_next_snake_pick_timer(
    v_draft.id,
    now() + make_interval(secs => p_pick_timer_seconds)
  );

  IF NOT v_is_mock THEN
    UPDATE leagues
       SET status = 'drafting'
     WHERE id = p_league_id
       AND status = 'offseason';

    GET DIAGNOSTICS v_pick_count = ROW_COUNT;
    IF v_pick_count <> 1 THEN
      RAISE EXCEPTION 'Failed to mark league as drafting';
    END IF;
  END IF;

  RETURN to_jsonb(v_draft);
END;
$$;

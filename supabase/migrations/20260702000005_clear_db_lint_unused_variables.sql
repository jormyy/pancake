CREATE OR REPLACE FUNCTION public.advance_playoff_bracket_atomic(
  p_league_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_season_id uuid;
  v_quarterfinal_count int;
  v_quarterfinal_week int;
  v_quarterfinal_winners uuid[];
  v_quarterfinals_ready boolean;
  v_semifinal_count int;
  v_semifinal_week int;
  v_semifinal_winners uuid[];
  v_semifinals_ready boolean;
  v_seed_ids uuid[];
  v_inserted_count int := 0;
BEGIN
  SELECT season.id
    INTO v_season_id
    FROM public.league_seasons AS season
    JOIN public.leagues AS league
      ON league.id = season.league_id
   WHERE season.league_id = p_league_id
     AND season.is_current = true
   FOR UPDATE OF season, league;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current league season not found for playoff advancement.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'), hashtext(v_season_id::text));

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type = 'playoff_final'::public.matchup_type
   FOR UPDATE;

  IF FOUND THEN
    RETURN jsonb_build_object('inserted', 0, 'skipped', true);
  END IF;

  SELECT count(*), min(week_number), array_agg(winner_member_id ORDER BY created_at, id), bool_and(is_finalized AND winner_member_id IS NOT NULL)
    INTO v_quarterfinal_count, v_quarterfinal_week, v_quarterfinal_winners, v_quarterfinals_ready
    FROM (
      SELECT *
        FROM public.matchups AS matchup
       WHERE matchup.league_season_id = v_season_id
         AND matchup.matchup_type = 'playoff_quarterfinal'::public.matchup_type
       ORDER BY matchup.created_at, matchup.id
       FOR UPDATE
    ) AS quarterfinals;

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type = 'playoff_semifinal'::public.matchup_type
   FOR UPDATE;

  IF v_quarterfinal_count > 0 AND NOT FOUND THEN
    IF v_quarterfinal_count < 2 OR v_quarterfinals_ready IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Quarterfinals are not yet finalized.';
    END IF;

    PERFORM 1
      FROM public.matchups AS matchup
     WHERE matchup.league_season_id = v_season_id
       AND matchup.matchup_type = 'regular_season'::public.matchup_type
       AND matchup.week_number < v_quarterfinal_week
       AND matchup.is_finalized = true
     FOR UPDATE;

    SELECT array_agg(seed.member_id ORDER BY seed.seed_rank)
      INTO v_seed_ids
      FROM private.playoff_seed_rankings(p_league_id, v_season_id, v_quarterfinal_week) AS seed;

    WITH inserted AS (
      INSERT INTO public.matchups (
        league_id,
        league_season_id,
        week_number,
        matchup_type,
        home_member_id,
        away_member_id
      )
      VALUES
        (p_league_id, v_season_id, v_quarterfinal_week + 1, 'playoff_semifinal'::public.matchup_type, v_seed_ids[1], v_quarterfinal_winners[2]),
        (p_league_id, v_season_id, v_quarterfinal_week + 1, 'playoff_semifinal'::public.matchup_type, v_seed_ids[2], v_quarterfinal_winners[1])
      ON CONFLICT (league_id, league_season_id, week_number, home_member_id, away_member_id)
      DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO v_inserted_count FROM inserted;

    RETURN jsonb_build_object('inserted', v_inserted_count, 'skipped', false);
  END IF;

  SELECT count(*), max(week_number), array_agg(winner_member_id ORDER BY created_at, id), bool_and(is_finalized AND winner_member_id IS NOT NULL)
    INTO v_semifinal_count, v_semifinal_week, v_semifinal_winners, v_semifinals_ready
    FROM (
      SELECT *
        FROM public.matchups AS matchup
       WHERE matchup.league_season_id = v_season_id
         AND matchup.matchup_type = 'playoff_semifinal'::public.matchup_type
       ORDER BY matchup.created_at, matchup.id
       FOR UPDATE
    ) AS semifinals;

  IF v_semifinal_count < 2 THEN
    RAISE EXCEPTION 'Semifinals not found.';
  END IF;

  IF v_semifinals_ready IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Semifinals are not yet finalized.';
  END IF;

  WITH inserted AS (
    INSERT INTO public.matchups (
      league_id,
      league_season_id,
      week_number,
      matchup_type,
      home_member_id,
      away_member_id
    )
    VALUES (
      p_league_id,
      v_season_id,
      v_semifinal_week + 1,
      'playoff_final'::public.matchup_type,
      v_semifinal_winners[1],
      v_semifinal_winners[2]
    )
    ON CONFLICT (league_id, league_season_id, week_number, home_member_id, away_member_id)
    DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted_count FROM inserted;

  RETURN jsonb_build_object('inserted', v_inserted_count, 'skipped', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_mock_draft_room_atomic(
  p_league_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_room_name text DEFAULT NULL,
  p_draft_type text DEFAULT 'auction',
  p_scheduled_at timestamptz DEFAULT NULL,
  p_nomination_order_mode text DEFAULT 'user_nominated',
  p_rounds int DEFAULT 3,
  p_pick_timer_seconds int DEFAULT 30,
  p_budget_per_team int DEFAULT NULL,
  p_timer_expiry_behavior text DEFAULT 'auto_pick'
)
RETURNS public.drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league public.leagues%ROWTYPE;
  v_season public.league_seasons%ROWTYPE;
  v_draft public.drafts%ROWTYPE;
  v_draft_type text := COALESCE(p_draft_type, 'auction');
  v_room_name text;
  v_budget int;
  v_timer_expiry_behavior text := COALESCE(p_timer_expiry_behavior, 'auto_pick');
BEGIN
  PERFORM 1
    FROM public.league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to create a room for this league member'
      USING ERRCODE = '42501';
  END IF;

  IF v_draft_type NOT IN ('auction', 'snake') THEN
    RAISE EXCEPTION 'Invalid mock draft room type: %', v_draft_type
      USING ERRCODE = 'P0001';
  END IF;

  IF p_pick_timer_seconds IS NULL OR p_pick_timer_seconds < 5 OR p_pick_timer_seconds > 3600 THEN
    RAISE EXCEPTION 'Draft timer seconds must be between 5 and 3600.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_nomination_order_mode NOT IN ('user_nominated', 'by_projection', 'alphabetical') THEN
    RAISE EXCEPTION 'Invalid nomination order mode: %', p_nomination_order_mode
      USING ERRCODE = 'P0001';
  END IF;

  IF v_timer_expiry_behavior NOT IN ('auto_pick', 'skip_pick', 'pause_draft', 'commissioner_pick') THEN
    RAISE EXCEPTION 'Invalid rookie draft timeout behavior: %', v_timer_expiry_behavior
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_league
    FROM public.leagues
   WHERE id = p_league_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT *
    INTO v_season
    FROM public.league_seasons
   WHERE league_id = p_league_id
     AND is_current = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season for this league' USING ERRCODE = 'P0002';
  END IF;

  IF v_draft_type = 'auction' THEN
    v_budget := COALESCE(p_budget_per_team, v_league.auction_budget);
    IF v_budget IS NULL OR v_budget <= 0 THEN
      RAISE EXCEPTION 'Auction budget must be a positive integer before creating a room.'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_rounds IS NULL OR p_rounds < 1 OR p_rounds > 10 THEN
    RAISE EXCEPTION 'Rookie draft rounds must be between 1 and 10.'
      USING ERRCODE = 'P0001';
  END IF;

  v_room_name := NULLIF(btrim(COALESCE(p_room_name, '')), '');
  IF v_room_name IS NULL THEN
    v_room_name := CASE WHEN v_draft_type = 'snake' THEN 'Mock Rookie Draft' ELSE 'Mock Auction' END;
  END IF;

  INSERT INTO public.drafts (
    league_id,
    league_season_id,
    draft_type,
    status,
    budget_per_team,
    scheduled_at,
    room_name,
    created_by_member_id,
    current_nomination_order,
    nomination_order_mode,
    is_mock,
    pick_timer_seconds,
    rounds,
    timer_expiry_behavior
  )
  VALUES (
    p_league_id,
    v_season.id,
    v_draft_type::public.draft_type,
    'pending',
    CASE WHEN v_draft_type = 'auction' THEN v_budget ELSE NULL END,
    COALESCE(p_scheduled_at, now()),
    v_room_name,
    p_member_id,
    1,
    p_nomination_order_mode,
    true,
    p_pick_timer_seconds,
    CASE WHEN v_draft_type = 'snake' THEN p_rounds ELSE NULL END,
    CASE WHEN v_draft_type = 'snake' THEN v_timer_expiry_behavior ELSE 'auction_no_bid' END
  )
  RETURNING * INTO v_draft;

  INSERT INTO public.draft_room_members (draft_id, member_id)
  VALUES (v_draft.id, p_member_id);

  RETURN v_draft;
END;
$$;

REVOKE ALL ON FUNCTION public.advance_playoff_bracket_atomic(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_mock_draft_room_atomic(uuid, uuid, uuid, text, text, timestamptz, text, int, int, int, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.advance_playoff_bracket_atomic(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_mock_draft_room_atomic(uuid, uuid, uuid, text, text, timestamptz, text, int, int, int, text) TO service_role;

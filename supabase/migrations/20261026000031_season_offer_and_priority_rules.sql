CREATE OR REPLACE FUNCTION public.advance_season_atomic(p_league_id uuid)
RETURNS TABLE(new_season_id uuid, new_year int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league leagues%ROWTYPE;
  v_current_season league_seasons%ROWTYPE;
  v_new_season_id uuid;
  v_new_year int;
  v_far_year int;
  v_previous_flag text;
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

  -- Prior+1 alone breaks a league that skipped a season or was created
  -- off-cycle: the derived year would never match season_weeks. The real
  -- calendar wins whenever it is ahead.
  v_new_year := GREATEST(
    v_current_season.season_year + 1,
    public.current_season_year_et(now())
  );
  v_far_year := v_new_year + 5;

  IF EXISTS (
    SELECT 1
      FROM league_seasons
     WHERE league_id = p_league_id
       AND season_year = v_new_year
  ) THEN
    RAISE EXCEPTION 'Season % already exists', v_new_year;
  END IF;

  v_previous_flag := private.begin_trade_lifecycle_write();
  UPDATE trades
     SET status = 'expired',
         completion_failure_reason = 'The season rolled over before this offer was accepted.'
   WHERE league_id = p_league_id
     AND league_season_id = v_current_season.id
     AND status = 'pending';
  PERFORM private.end_trade_lifecycle_write(v_previous_flag);

  UPDATE league_seasons
     SET is_current = false
   WHERE id = v_current_season.id;

  INSERT INTO league_seasons (league_id, season_year, is_current, rookie_draft_scheduled_at)
  VALUES (p_league_id, v_new_year, true, now() + interval '60 days')
  RETURNING id INTO v_new_season_id;

  PERFORM private.authorize_taxi_acquisition(p_league_id,v_new_season_id,member_id,player_id,'carry_over',v_current_season.id)
    FROM roster_players WHERE league_id=p_league_id AND league_season_id=v_current_season.id AND is_on_taxi;

  INSERT INTO roster_players (
    league_id,
    league_season_id,
    member_id,
    player_id,
    is_on_ir,
    is_on_taxi,
    taxi_start_season_year,
    acquired_via
  )
  SELECT
    p_league_id,
    v_new_season_id,
    member_id,
    player_id,
    is_on_ir,
    is_on_taxi,
    taxi_start_season_year,
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

  INSERT INTO roster_transactions(league_id,league_season_id,member_id,player_id,transaction_type,occurred_at)
  SELECT current.league_id,current.league_season_id,current.member_id,current.player_id,'taxi_return',current.acquired_at+interval '1 millisecond'
  FROM roster_players current JOIN roster_players previous ON previous.league_season_id=v_current_season.id
    AND previous.member_id=current.member_id AND previous.player_id=current.player_id
  WHERE current.league_season_id=v_new_season_id AND previous.is_on_taxi AND NOT current.is_on_taxi;

  -- Fill skipped pick years and preserve existing owners.
  INSERT INTO draft_picks (
    league_id,
    season_year,
    round,
    original_owner_id,
    current_owner_id
  )
  SELECT
    p_league_id,
    year_value,
    round_value,
    lm.id,
    lm.id
  FROM league_members lm
  CROSS JOIN generate_series(v_new_year,v_far_year) AS year_value
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
      ties,
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
          (COALESCE(ls.wins, 0) + 0.5 * COALESCE(ls.ties, 0)) / GREATEST(COALESCE(ls.wins + ls.losses + ls.ties, 0), 1) ASC,
          COALESCE(ls.points_for, 0) / GREATEST(COALESCE(ls.wins + ls.losses + ls.ties, 0), 1) ASC,
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

  -- The trade deadline repeats every season.
  UPDATE leagues
     SET status = 'offseason',
         trade_deadline = private.trade_deadline_for_season(trade_deadline, v_new_year)
   WHERE id = p_league_id;

  new_season_id := v_new_season_id;
  new_year := v_new_year;
  RETURN NEXT;
END;
$$;


CREATE OR REPLACE FUNCTION public.start_rookie_draft_atomic(
  p_league_id uuid,
  p_rounds int DEFAULT 3,
  p_is_mock boolean DEFAULT false,
  p_pick_timer_seconds int DEFAULT 60,
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
  IF p_rounds < 1 OR p_rounds > 3 THEN
    RAISE EXCEPTION 'Rookie draft rounds must be between 1 and 3.';
  END IF;
  IF p_pick_timer_seconds IS NULL OR p_pick_timer_seconds < 60 OR p_pick_timer_seconds > 604800 THEN
    RAISE EXCEPTION 'Draft timer seconds must be between 60 and 604800.'
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

  IF NOT v_is_mock AND EXISTS (
    SELECT 1
      FROM draft_picks AS pick
     WHERE pick.league_id = p_league_id
       AND pick.season_year = v_season.season_year
       AND pick.is_used = false
       AND private.is_reserved_trade_asset(pick.league_id, NULL, pick.current_owner_id, NULL, pick.id)
  ) THEN
    RAISE EXCEPTION 'A pick in this draft class is reserved by an accepted trade. Complete or veto that trade before starting the rookie draft.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*)
    INTO v_member_count
    FROM league_members
   WHERE league_id = p_league_id;

  IF v_member_count < 2 THEN
    RAISE EXCEPTION 'Need at least 2 managers to start a draft';
  END IF;

  IF NOT v_is_mock THEN
    PERFORM private.league_playoff_round_plan(v_league.id, v_member_count);
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
      (COALESCE(latest.wins, 0) + 0.5 * COALESCE(latest.ties, 0)) / GREATEST(COALESCE(latest.wins + latest.losses + latest.ties, 0), 1) AS win_rate,
      COALESCE(latest.points_for, 0) / GREATEST(COALESCE(latest.wins + latest.losses + latest.ties, 0), 1) AS points_per_game
    FROM league_members AS lm
    LEFT JOIN LATERAL (
      SELECT s.member_id, s.wins, s.losses, s.ties, s.points_for
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
          win_rate ASC,
          points_per_game ASC,
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
    clock_timestamp() + make_interval(secs => p_pick_timer_seconds)
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


CREATE OR REPLACE FUNCTION public.get_trade_page_refs(
  p_member_id uuid,
  p_league_id uuid,
  p_limit int DEFAULT 40,
  p_cursor text DEFAULT NULL
)
RETURNS TABLE (trade_id uuid, cursor_token text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cursor jsonb;
  v_cursor_tier int;
  v_cursor_at timestamptz;
  v_cursor_id uuid;
  v_limit int := LEAST(GREATEST(p_limit, 1), 100);
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.league_members AS own_member
     WHERE own_member.id = p_member_id
       AND own_member.league_id = p_league_id
       AND own_member.user_id = (SELECT auth.uid())
  ) THEN
    RETURN;
  END IF;

  IF p_cursor IS NOT NULL THEN
    BEGIN
      v_cursor := convert_from(decode(p_cursor, 'base64'), 'UTF8')::jsonb;
      v_cursor_tier := (v_cursor->>'tier')::int;
      v_cursor_at := (v_cursor->>'at')::timestamptz;
      v_cursor_id := (v_cursor->>'id')::uuid;
      IF v_cursor_tier NOT BETWEEN 1 AND 3 OR v_cursor_at IS NULL OR v_cursor_id IS NULL THEN
        RAISE EXCEPTION 'invalid cursor';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Trade page cursor is invalid.' USING ERRCODE = '22023';
    END;
  END IF;

  RETURN QUERY
  WITH observer_actions AS (
    SELECT trade.id, 2 AS tier, trade.proposed_at
      FROM public.trades AS trade
     WHERE trade.league_id = p_league_id
       AND EXISTS (SELECT 1 FROM public.league_seasons AS season
         WHERE season.id = trade.league_season_id AND season.is_current)
       AND trade.status = 'accepted'::public.trade_status
       AND trade.veto_window_expires_at > now()
       AND NOT EXISTS (
         SELECT 1
           FROM public.trade_participants AS participant
          WHERE participant.trade_id = trade.id
            AND participant.member_id = p_member_id
       )
       AND (
         v_cursor_tier IS NULL OR 2 < v_cursor_tier OR
         (v_cursor_tier = 2 AND (trade.proposed_at, trade.id) < (v_cursor_at, v_cursor_id))
       )
     ORDER BY trade.proposed_at DESC, trade.id DESC
     LIMIT v_limit
  ), participant_actions AS (
    SELECT trade.id, 3 AS tier, trade.proposed_at
      FROM public.trade_participants AS participant
      JOIN public.trades AS trade ON trade.id = participant.trade_id
     WHERE participant.league_id = p_league_id
       AND participant.member_id = p_member_id
       AND participant.accepted_at IS NULL
       AND EXISTS (SELECT 1 FROM public.league_seasons AS season
         WHERE season.id = trade.league_season_id AND season.is_current)
       AND trade.status = 'pending'::public.trade_status
       AND (
         v_cursor_tier IS NULL OR 3 < v_cursor_tier OR
         (v_cursor_tier = 3 AND (participant.proposed_at, participant.trade_id) < (v_cursor_at, v_cursor_id))
       )
     ORDER BY participant.proposed_at DESC, participant.trade_id DESC
     LIMIT v_limit
  ), participant_outgoing AS (
    SELECT trade.id, 1 AS tier, trade.proposed_at
      FROM public.trade_participants AS participant
      JOIN public.trades AS trade ON trade.id = participant.trade_id
     WHERE participant.league_id = p_league_id
       AND participant.member_id = p_member_id
       AND EXISTS (SELECT 1 FROM public.league_seasons AS season
         WHERE season.id = trade.league_season_id AND season.is_current)
       AND trade.status = 'pending'::public.trade_status
       AND participant.accepted_at IS NOT NULL
       AND (
         v_cursor_tier IS NULL OR 1 < v_cursor_tier OR
         (v_cursor_tier = 1 AND (participant.proposed_at, participant.trade_id) < (v_cursor_at, v_cursor_id))
       )
     ORDER BY participant.proposed_at DESC, participant.trade_id DESC
     LIMIT v_limit
  ), page AS (
    SELECT * FROM observer_actions
    UNION ALL
    SELECT * FROM participant_actions
    UNION ALL
    SELECT * FROM participant_outgoing
    ORDER BY tier DESC, proposed_at DESC, id DESC
    LIMIT v_limit
  )
  SELECT page.id,
    encode(convert_to(jsonb_build_object(
      'tier', page.tier,
      'at', page.proposed_at,
      'id', page.id
    )::text, 'UTF8'), 'base64')
    FROM page
   ORDER BY page.tier DESC, page.proposed_at DESC, page.id DESC;
END;
$$;


CREATE OR REPLACE FUNCTION public.get_pending_trade_count(
  p_member_id uuid,
  p_league_id uuid
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT count(*)
    FROM public.trades AS trade
    JOIN public.trade_participants AS participant
      ON participant.trade_id = trade.id
     AND participant.member_id = p_member_id
     AND participant.accepted_at IS NULL
   WHERE trade.league_id = p_league_id
     AND EXISTS (SELECT 1 FROM public.league_seasons AS season
       WHERE season.id = trade.league_season_id AND season.is_current)
     AND trade.status = 'pending'::public.trade_status
     AND EXISTS (
       SELECT 1
         FROM public.league_members AS own_member
        WHERE own_member.id = p_member_id
          AND own_member.league_id = p_league_id
          AND own_member.user_id = (SELECT auth.uid())
     );
$$;

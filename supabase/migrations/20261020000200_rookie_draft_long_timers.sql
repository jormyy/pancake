ALTER TABLE public.drafts DROP CONSTRAINT drafts_pick_timer_seconds_range;
UPDATE public.drafts SET pick_timer_seconds = 60 WHERE draft_type = 'snake' AND pick_timer_seconds < 60;
ALTER TABLE public.drafts ADD CONSTRAINT drafts_pick_timer_seconds_range CHECK (
  (draft_type = 'snake' AND pick_timer_seconds BETWEEN 60 AND 604800)
  OR (draft_type <> 'snake' AND pick_timer_seconds BETWEEN 5 AND 3600)
);

CREATE OR REPLACE FUNCTION private.draft_timer_opening_night_cutoff(p_season_year int)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT (min(game_date)::timestamp + interval '9 hours') AT TIME ZONE 'America/New_York'
    FROM public.nba_games
   WHERE season_year = p_season_year
     AND nba_game_id ~ '^002[0-9]{7}$';
$$;

CREATE OR REPLACE FUNCTION private.draft_timer_opening_night_completion_enabled()
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$ SELECT true; $$;

CREATE OR REPLACE FUNCTION public.draft_timer_start_warning(
  p_league_id uuid,
  p_rounds int DEFAULT 3,
  p_pick_timer_seconds int DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_season_year int;
  v_picks int;
  v_cutoff timestamptz;
  v_finish timestamptz;
BEGIN
  IF p_rounds IS NULL OR p_rounds < 1 OR p_rounds > 3 THEN
    RAISE EXCEPTION 'Rookie draft rounds must be between 1 and 3.';
  END IF;
  IF p_pick_timer_seconds IS NULL OR p_pick_timer_seconds < 60 OR p_pick_timer_seconds > 604800 THEN
    RAISE EXCEPTION 'Draft timer seconds must be between 60 and 604800.';
  END IF;
  SELECT season_year INTO v_season_year FROM league_seasons WHERE league_id = p_league_id AND is_current;
  IF NOT FOUND THEN RAISE EXCEPTION 'No active season for this league'; END IF;
  SELECT count(*) * p_rounds INTO v_picks FROM league_members WHERE league_id = p_league_id;
  v_cutoff := private.draft_timer_opening_night_cutoff(v_season_year);
  v_finish := clock_timestamp() + make_interval(secs => v_picks::double precision * p_pick_timer_seconds);
  RETURN jsonb_build_object(
    'code', CASE WHEN v_cutoff IS NULL THEN 'opening_night_unpublished'
                 WHEN v_finish >= v_cutoff THEN 'opening_night_overrun' ELSE NULL END,
    'openingNightCutoff', v_cutoff,
    'estimatedFinishAt', v_finish,
    'remainingPicks', v_picks,
    'timerSeconds', p_pick_timer_seconds
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.draft_timer_complete_opening_night(
  p_limit int DEFAULT 100,
  p_at timestamptz DEFAULT clock_timestamp()
)
RETURNS TABLE (
  pick_id uuid, draft_id uuid, member_id uuid, player_id uuid,
  picked boolean, error_code text, error_message text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft record;
  v_pick record;
  v_result jsonb;
BEGIN
  IF NOT private.draft_timer_opening_night_completion_enabled() THEN RETURN; END IF;
  FOR v_draft IN
    SELECT draft.id
      FROM drafts AS draft
      JOIN league_seasons AS season ON season.id = draft.league_season_id AND season.is_current
     WHERE draft.draft_type = 'snake' AND NOT draft.is_mock
       AND draft.status IN ('in_progress', 'paused')
       AND private.draft_timer_opening_night_cutoff(season.season_year) <= p_at
     ORDER BY draft.id
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 0), 500)
  LOOP
    BEGIN
      IF NOT pg_try_advisory_xact_lock(hashtext(v_draft.id::text), 0) THEN CONTINUE; END IF;
      PERFORM 1 FROM drafts WHERE id = v_draft.id AND status IN ('in_progress', 'paused') FOR UPDATE;
      IF NOT FOUND THEN CONTINUE; END IF;
      FOR v_pick IN
        SELECT pick.id, pick.member_id FROM snake_draft_picks AS pick
         WHERE pick.draft_id = v_draft.id AND pick.player_id IS NULL AND pick.skipped_at IS NULL
         ORDER BY pick.overall_pick
      LOOP
        v_result := public.auto_pick_snake_pick_atomic(v_draft.id, v_pick.member_id, 'season_boundary_backstop');
        RETURN QUERY SELECT v_pick.id, v_draft.id, v_pick.member_id,
          (v_result->>'player_id')::uuid, true, NULL::text, NULL::text;
      END LOOP;
      PERFORM private.complete_rookie_draft_if_ready(v_draft.id, p_at);
      INSERT INTO draft_audit_logs(draft_id, league_id, action, metadata)
        SELECT id, league_id, 'opening_night_completion', jsonb_build_object('cutoff', p_at)
          FROM drafts WHERE id = v_draft.id;
    EXCEPTION WHEN OTHERS THEN
      RETURN QUERY SELECT NULL::uuid, v_draft.id, NULL::uuid, NULL::uuid, false, SQLSTATE::text, SQLERRM::text;
    END;
  END LOOP;
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

CREATE OR REPLACE FUNCTION public.pause_draft_atomic(
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
  v_remaining_seconds int;
  v_now timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found.';
  END IF;
  IF v_draft.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Only an in-progress draft can be paused.';
  END IF;

  v_now := clock_timestamp();

  IF v_draft.draft_type = 'auction' THEN
    SELECT GREATEST(CEIL(EXTRACT(EPOCH FROM (countdown_expires_at - v_now)))::int, 0)
      INTO v_remaining_seconds
      FROM nominations
     WHERE draft_id = p_draft_id
       AND status = 'open'
       AND countdown_expires_at IS NOT NULL
     ORDER BY nominated_at DESC
     LIMIT 1
     FOR UPDATE;

    UPDATE nominations
       SET countdown_expires_at = NULL
     WHERE draft_id = p_draft_id
       AND status = 'open';
  ELSE
    SELECT GREATEST(CEIL(EXTRACT(EPOCH FROM (timer_expires_at - v_now)))::int, 0)
      INTO v_remaining_seconds
      FROM snake_draft_picks
     WHERE draft_id = p_draft_id
       AND player_id IS NULL
       AND skipped_at IS NULL
       AND timer_expires_at IS NOT NULL
     ORDER BY overall_pick
     LIMIT 1
     FOR UPDATE;

    UPDATE snake_draft_picks
       SET timer_expires_at = NULL
     WHERE draft_id = p_draft_id
       AND player_id IS NULL
       AND skipped_at IS NULL;
  END IF;

  UPDATE drafts
     SET status = 'paused',
         paused_at = v_now,
         timer_paused_remaining_seconds = v_remaining_seconds,
         pause_reason = 'manual'
   WHERE id = p_draft_id;

  INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
  VALUES (
    p_draft_id,
    v_draft.league_id,
    p_actor_user_id,
    'pause',
    jsonb_build_object('previousStatus', v_draft.status, 'remainingSeconds', v_remaining_seconds, 'isMock', v_draft.is_mock)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.resume_draft_atomic(
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
  v_remaining_seconds int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found.';
  END IF;
  IF v_draft.status <> 'paused' THEN
    RAISE EXCEPTION 'Only a paused draft can be resumed.';
  END IF;
  IF v_draft.pause_reason = 'timer_expired_commissioner_pick' THEN
    RAISE EXCEPTION 'Draft is waiting for a commissioner pick.'
      USING ERRCODE = 'P0001';
  END IF;

  v_remaining_seconds := COALESCE(v_draft.timer_paused_remaining_seconds, v_draft.pick_timer_seconds, CASE WHEN v_draft.draft_type = 'snake' THEN 60 ELSE 30 END);

  IF v_draft.draft_type = 'auction' THEN
    UPDATE nominations
       SET countdown_expires_at = clock_timestamp() + make_interval(secs => v_remaining_seconds)
     WHERE draft_id = p_draft_id
       AND status = 'open';
  ELSE
    PERFORM private.arm_next_snake_pick_timer(
      p_draft_id,
      clock_timestamp() + make_interval(secs => v_remaining_seconds)
    );
  END IF;

  UPDATE drafts
     SET status = 'in_progress',
         paused_at = NULL,
         timer_paused_remaining_seconds = NULL,
         pause_reason = NULL
   WHERE id = p_draft_id;

  INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
  VALUES (
    p_draft_id,
    v_draft.league_id,
    p_actor_user_id,
    'resume',
    jsonb_build_object('previousStatus', v_draft.status, 'remainingSeconds', v_remaining_seconds, 'isMock', v_draft.is_mock)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.process_expired_snake_pick_atomic(
  p_draft_id uuid
)
RETURNS TABLE (
  pick_id uuid,
  draft_id uuid,
  member_id uuid,
  player_id uuid,
  picked boolean,
  error_code text,
  error_message text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_pick snake_draft_picks%ROWTYPE;
  v_player_id uuid;
  v_result jsonb;
  v_remaining int;
  v_rows int;
  v_now timestamptz;
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

  IF v_draft.draft_type <> 'snake'::draft_type
     OR v_draft.status <> 'in_progress'::draft_status THEN
    RETURN;
  END IF;

  v_now := clock_timestamp();

  SELECT pick.*
    INTO v_pick
    FROM snake_draft_picks AS pick
   WHERE pick.draft_id = p_draft_id
     AND pick.player_id IS NULL
     AND pick.skipped_at IS NULL
     AND pick.timer_expires_at IS NOT NULL
     AND pick.timer_expires_at <= v_now
     AND NOT EXISTS (
       SELECT 1
         FROM snake_draft_picks AS earlier
        WHERE earlier.draft_id = pick.draft_id
          AND earlier.player_id IS NULL
          AND earlier.skipped_at IS NULL
          AND earlier.overall_pick < pick.overall_pick
     )
   ORDER BY pick.overall_pick, pick.id
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  BEGIN
    IF v_draft.timer_expiry_behavior = 'skip_pick' THEN
      UPDATE snake_draft_picks AS pick
         SET skipped_at = v_now,
             skip_reason = 'timer_expired',
             timer_expires_at = NULL
       WHERE pick.id = v_pick.id
         AND pick.player_id IS NULL
         AND pick.skipped_at IS NULL;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Expired snake pick was already resolved'
          USING ERRCODE = 'P0001';
      END IF;

      IF NOT v_draft.is_mock AND v_pick.draft_pick_id IS NOT NULL THEN
        UPDATE draft_picks
           SET is_used = true,
               used_at = v_now,
               rookie_draft_id = v_pick.draft_id
         WHERE id = v_pick.draft_pick_id
           AND league_id = v_draft.league_id
           AND current_owner_id = v_pick.member_id
           AND round = v_pick.round
           AND is_used = false;

        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows <> 1 THEN
          RAISE EXCEPTION 'Draft-pick asset is no longer owned by the manager on the clock'
            USING ERRCODE = 'P0001';
        END IF;
      END IF;

      INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
      VALUES (
        v_pick.draft_id,
        v_draft.league_id,
        NULL,
        'skip_pick',
        jsonb_build_object(
          'reason', 'timer_expired',
          'memberId', v_pick.member_id,
          'pickId', v_pick.id,
          'behavior', v_draft.timer_expiry_behavior
        )
      );

      SELECT count(*)
        INTO v_remaining
        FROM snake_draft_picks AS pick
       WHERE pick.draft_id = v_pick.draft_id
         AND pick.player_id IS NULL
         AND pick.skipped_at IS NULL;

      IF v_remaining > 0 THEN
        PERFORM private.arm_next_snake_pick_timer(
          v_pick.draft_id,
          v_now + make_interval(secs => v_draft.pick_timer_seconds)
        );
      ELSE
        PERFORM private.complete_rookie_draft_if_ready(v_pick.draft_id, v_now);
      END IF;

      RETURN QUERY
      SELECT
        v_pick.id,
        v_pick.draft_id,
        v_pick.member_id,
        NULL::uuid,
        false,
        NULL::text,
        NULL::text;

    ELSIF v_draft.timer_expiry_behavior IN ('pause_draft', 'commissioner_pick') THEN
      UPDATE snake_draft_picks AS pick
         SET timer_expires_at = NULL
       WHERE pick.id = v_pick.id
         AND pick.player_id IS NULL
         AND pick.skipped_at IS NULL;

      UPDATE drafts
         SET status = 'paused',
             paused_at = v_now,
             timer_paused_remaining_seconds = NULL,
             pause_reason = CASE
               WHEN v_draft.timer_expiry_behavior = 'commissioner_pick' THEN 'timer_expired_commissioner_pick'
               ELSE 'timer_expired_pause'
             END
       WHERE id = v_pick.draft_id
         AND status = 'in_progress';

      INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
      VALUES (
        v_pick.draft_id,
        v_draft.league_id,
        NULL,
        CASE
          WHEN v_draft.timer_expiry_behavior = 'commissioner_pick' THEN 'timer_expired_commissioner_pick'
          ELSE 'timer_expired_pause'
        END,
        jsonb_build_object(
          'memberId', v_pick.member_id,
          'pickId', v_pick.id,
          'behavior', v_draft.timer_expiry_behavior
        )
      );

      RETURN QUERY
      SELECT
        v_pick.id,
        v_pick.draft_id,
        v_pick.member_id,
        NULL::uuid,
        false,
        NULL::text,
        NULL::text;

    ELSE
      v_result := public.auto_pick_snake_pick_atomic(v_pick.draft_id, v_pick.member_id, 'timer_expired');
      v_player_id := (v_result->>'player_id')::uuid;

      RETURN QUERY
      SELECT
        v_pick.id,
        v_pick.draft_id,
        v_pick.member_id,
        v_player_id,
        true,
        NULL::text,
        NULL::text;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY
    SELECT
      v_pick.id,
      v_pick.draft_id,
      v_pick.member_id,
      v_player_id,
      false,
      SQLSTATE::text,
      SQLERRM::text;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.process_expired_snake_picks_atomic(
  p_limit int DEFAULT 100
)
RETURNS TABLE (
  pick_id uuid,
  draft_id uuid,
  member_id uuid,
  player_id uuid,
  picked boolean,
  error_code text,
  error_message text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 100), 0), 500);
  v_candidate record;
  v_pick snake_draft_picks%ROWTYPE;
  v_draft drafts%ROWTYPE;
  v_player_id uuid;
  v_result jsonb;
  v_remaining int;
  v_rows int;
  v_now timestamptz;
BEGIN
  RETURN QUERY SELECT * FROM private.draft_timer_complete_opening_night(v_limit);

  FOR v_candidate IN
    SELECT
      pick.id AS pick_id,
      pick.draft_id,
      pick.member_id
    FROM snake_draft_picks AS pick
    JOIN drafts AS draft
      ON draft.id = pick.draft_id
     AND draft.draft_type = 'snake'
     AND draft.status = 'in_progress'
   WHERE pick.player_id IS NULL
     AND pick.skipped_at IS NULL
     AND pick.timer_expires_at IS NOT NULL
     AND pick.timer_expires_at <= clock_timestamp()
     AND NOT EXISTS (
       SELECT 1
         FROM snake_draft_picks AS earlier
        WHERE earlier.draft_id = pick.draft_id
          AND earlier.player_id IS NULL
          AND earlier.skipped_at IS NULL
          AND earlier.overall_pick < pick.overall_pick
     )
   ORDER BY pick.timer_expires_at, pick.overall_pick, pick.id
   LIMIT v_limit
  LOOP
    BEGIN
      v_player_id := NULL;
      v_now := clock_timestamp();

      IF NOT pg_try_advisory_xact_lock(hashtext(v_candidate.draft_id::text), 0) THEN
        CONTINUE;
      END IF;

      SELECT *
        INTO v_draft
        FROM drafts
       WHERE id = v_candidate.draft_id
       FOR UPDATE;

      IF NOT FOUND
         OR v_draft.status <> 'in_progress'::draft_status
         OR v_draft.draft_type <> 'snake'::draft_type THEN
        CONTINUE;
      END IF;

      SELECT pick.*
        INTO v_pick
        FROM snake_draft_picks AS pick
       WHERE pick.id = v_candidate.pick_id
         AND pick.draft_id = v_candidate.draft_id
         AND pick.player_id IS NULL
         AND pick.skipped_at IS NULL
         AND pick.timer_expires_at IS NOT NULL
         AND pick.timer_expires_at <= v_now
         AND NOT EXISTS (
           SELECT 1
             FROM snake_draft_picks AS earlier
            WHERE earlier.draft_id = pick.draft_id
              AND earlier.player_id IS NULL
              AND earlier.skipped_at IS NULL
              AND earlier.overall_pick < pick.overall_pick
         )
       FOR UPDATE;

      IF NOT FOUND THEN
        CONTINUE;
      END IF;

      IF v_draft.timer_expiry_behavior = 'skip_pick' THEN
        UPDATE snake_draft_picks AS pick
           SET skipped_at = v_now,
               skip_reason = 'timer_expired',
               timer_expires_at = NULL
         WHERE pick.id = v_pick.id
           AND pick.player_id IS NULL
           AND pick.skipped_at IS NULL;

        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows <> 1 THEN
          RAISE EXCEPTION 'Expired snake pick was already resolved'
            USING ERRCODE = 'P0001';
        END IF;

        IF NOT v_draft.is_mock AND v_pick.draft_pick_id IS NOT NULL THEN
          UPDATE draft_picks
             SET is_used = true,
                 used_at = v_now,
                 rookie_draft_id = v_pick.draft_id
           WHERE id = v_pick.draft_pick_id
             AND league_id = v_draft.league_id
             AND current_owner_id = v_pick.member_id
             AND round = v_pick.round
             AND is_used = false;

          GET DIAGNOSTICS v_rows = ROW_COUNT;
          IF v_rows <> 1 THEN
            RAISE EXCEPTION 'Draft-pick asset is no longer owned by the manager on the clock'
              USING ERRCODE = 'P0001';
          END IF;
        END IF;

        INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
        VALUES (
          v_pick.draft_id,
          v_draft.league_id,
          NULL,
          'skip_pick',
          jsonb_build_object(
            'reason', 'timer_expired',
            'memberId', v_pick.member_id,
            'pickId', v_pick.id,
            'behavior', v_draft.timer_expiry_behavior
          )
        );

        SELECT count(*)
          INTO v_remaining
          FROM snake_draft_picks AS pick
         WHERE pick.draft_id = v_pick.draft_id
           AND pick.player_id IS NULL
           AND pick.skipped_at IS NULL;

        IF v_remaining > 0 THEN
          PERFORM private.arm_next_snake_pick_timer(
            v_pick.draft_id,
            v_now + make_interval(secs => v_draft.pick_timer_seconds)
          );
        ELSE
          PERFORM private.complete_rookie_draft_if_ready(v_pick.draft_id, v_now);
        END IF;

        RETURN QUERY
        SELECT
          v_pick.id,
          v_pick.draft_id,
          v_pick.member_id,
          NULL::uuid,
          false,
          NULL::text,
          NULL::text;

      ELSIF v_draft.timer_expiry_behavior IN ('pause_draft', 'commissioner_pick') THEN
        UPDATE snake_draft_picks AS pick
           SET timer_expires_at = NULL
         WHERE pick.id = v_pick.id
           AND pick.player_id IS NULL
           AND pick.skipped_at IS NULL;

        UPDATE drafts
           SET status = 'paused',
               paused_at = v_now,
               timer_paused_remaining_seconds = NULL,
               pause_reason = CASE
                 WHEN v_draft.timer_expiry_behavior = 'commissioner_pick' THEN 'timer_expired_commissioner_pick'
                 ELSE 'timer_expired_pause'
               END
         WHERE id = v_pick.draft_id
           AND status = 'in_progress';

        INSERT INTO draft_audit_logs (draft_id, league_id, actor_user_id, action, metadata)
        VALUES (
          v_pick.draft_id,
          v_draft.league_id,
          NULL,
          CASE
            WHEN v_draft.timer_expiry_behavior = 'commissioner_pick' THEN 'timer_expired_commissioner_pick'
            ELSE 'timer_expired_pause'
          END,
          jsonb_build_object(
            'memberId', v_pick.member_id,
            'pickId', v_pick.id,
            'behavior', v_draft.timer_expiry_behavior
          )
        );

        RETURN QUERY
        SELECT
          v_pick.id,
          v_pick.draft_id,
          v_pick.member_id,
          NULL::uuid,
          false,
          NULL::text,
          NULL::text;

      ELSE
        v_result := public.auto_pick_snake_pick_atomic(v_pick.draft_id, v_pick.member_id, 'timer_expired');
        v_player_id := (v_result->>'player_id')::uuid;

        RETURN QUERY
        SELECT
          v_pick.id,
          v_pick.draft_id,
          v_pick.member_id,
          v_player_id,
          true,
          NULL::text,
          NULL::text;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RETURN QUERY
      SELECT
        v_candidate.pick_id,
        v_candidate.draft_id,
        v_candidate.member_id,
        v_player_id,
        false,
        SQLSTATE::text,
        SQLERRM::text;
    END;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_close_expired_nominations_if_due()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- One cron period ahead. The edge function claims with its own, later now(),
  -- so a deadline that passes between this check and that claim still closes
  -- on this tick, exactly as when every tick invoked the function.
  v_horizon timestamptz := now() + interval '1 minute';
BEGIN
  -- Nothing can be due without an in-progress draft. Checking that first keeps
  -- an idle tick, which runs in a fresh pg_cron session, to one small plan.
  IF NOT EXISTS (
    SELECT 1 FROM public.drafts WHERE status IN ('in_progress'::public.draft_status, 'paused'::public.draft_status)
  ) THEN
    RETURN;
  END IF;

  -- Mirrors the candidate queries of close_expired_auction_nominations_atomic
  -- and process_expired_snake_picks_atomic.
  IF EXISTS (
    SELECT 1 FROM public.drafts AS draft
    JOIN public.league_seasons AS season ON season.id = draft.league_season_id AND season.is_current
    WHERE draft.draft_type = 'snake' AND NOT draft.is_mock
      AND draft.status IN ('in_progress', 'paused')
      AND private.draft_timer_opening_night_completion_enabled()
      AND private.draft_timer_opening_night_cutoff(season.season_year) < v_horizon
  ) OR EXISTS (
    SELECT 1
      FROM public.nominations AS nomination
      JOIN public.drafts AS draft
        ON draft.id = nomination.draft_id
     WHERE nomination.status = 'open'::public.nomination_status
       AND nomination.countdown_expires_at < v_horizon
       AND draft.status = 'in_progress'::public.draft_status
  ) OR EXISTS (
    SELECT 1
      FROM public.snake_draft_picks AS pick
      JOIN public.drafts AS draft
        ON draft.id = pick.draft_id
     WHERE pick.player_id IS NULL
       AND pick.skipped_at IS NULL
       AND pick.timer_expires_at IS NOT NULL
       AND pick.timer_expires_at < v_horizon
       AND draft.draft_type = 'snake'
       AND draft.status = 'in_progress'
  ) THEN
    PERFORM public.invoke_edge_function('close-expired-nominations');
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.draft_timer_opening_night_cutoff(int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.draft_timer_opening_night_completion_enabled() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.draft_timer_complete_opening_night(int, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.draft_timer_start_warning(uuid, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.draft_timer_start_warning(uuid, int, int) TO service_role;

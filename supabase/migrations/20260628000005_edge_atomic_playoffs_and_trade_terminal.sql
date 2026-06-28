-- Finish the Edge cutover hardening:
-- - playoff bracket decisions and writes live in one SQL transaction
-- - trade completion only terminalizes explicit domain-drift failures
-- - reject/withdraw trade terminal states live behind service-role RPCs
-- - DB cron configuration fails closed when the internal token is missing

ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS completion_failure_reason text;

CREATE OR REPLACE FUNCTION public.expire_trade_completion_failure_atomic(
  p_trade_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_rows int;
  v_league_status text;
  v_is_current boolean;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
     AND status = 'accepted'
     AND veto_window_expires_at <= now()
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade is not an expired accepted trade';
  END IF;

  SELECT status
    INTO v_league_status
    FROM leagues
   WHERE id = v_trade.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  SELECT is_current
    INTO v_is_current
    FROM league_seasons
   WHERE id = v_trade.league_season_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade season not found.';
  END IF;

  IF v_is_current IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Trades require the current season.';
  END IF;

  IF v_league_status NOT IN ('active', 'playoffs') THEN
    RAISE EXCEPTION 'Trades require an active or playoff season.';
  END IF;

  DELETE FROM trade_drop_reservations
   WHERE trade_id = p_trade_id;

  UPDATE trades
     SET status = 'expired',
         completed_at = NULL,
         completion_failure_reason = p_reason
   WHERE id = p_trade_id
     AND status = 'accepted';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to expire accepted trade';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_trade_atomic(
  p_trade_id uuid,
  p_member_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_trade.status <> 'pending'::public.trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.recipient_member_id <> p_member_id THEN
    RAISE EXCEPTION 'Only the trade recipient can reject this trade.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM public.league_members AS member
   WHERE member.id = p_member_id
     AND member.user_id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to act for this member.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.trades
     SET status = 'rejected'::public.trade_status
   WHERE id = p_trade_id
     AND status = 'pending'::public.trade_status;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'proposerMemberId', v_trade.proposer_member_id,
    'recipientMemberId', v_trade.recipient_member_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.withdraw_trade_atomic(
  p_trade_id uuid,
  p_member_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_trade.status <> 'pending'::public.trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.proposer_member_id <> p_member_id THEN
    RAISE EXCEPTION 'Only the trade proposer can withdraw this trade.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM public.league_members AS member
   WHERE member.id = p_member_id
     AND member.user_id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to act for this member.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.trades
     SET status = 'withdrawn'::public.trade_status
   WHERE id = p_trade_id
     AND status = 'pending'::public.trade_status;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'proposerMemberId', v_trade.proposer_member_id,
    'recipientMemberId', v_trade.recipient_member_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_accepted_trade_atomic(
  p_trade_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_item trade_items%ROWTYPE;
  v_drop trade_drop_reservations%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_from_member uuid;
  v_to_member uuid;
  v_member_lock uuid;
  v_lock_player_id uuid;
  v_rows int;
  v_active_count int;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found';
  END IF;

  IF v_trade.status <> 'accepted' THEN
    RAISE EXCEPTION 'Trade is not ready to complete';
  END IF;

  IF v_trade.veto_window_expires_at IS NULL OR v_trade.veto_window_expires_at > now() THEN
    RAISE EXCEPTION 'Trade veto window is still open';
  END IF;

  FOR v_member_lock IN
    SELECT member_id
      FROM (
        VALUES (v_trade.proposer_member_id), (v_trade.recipient_member_id)
      ) AS members(member_id)
     ORDER BY member_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext(v_trade.league_id::text),
      hashtext(v_member_lock::text)
    );
  END LOOP;

  FOR v_lock_player_id IN
    SELECT DISTINCT player_id
      FROM (
        SELECT player_id
          FROM trade_items
         WHERE trade_id = p_trade_id
           AND player_id IS NOT NULL
        UNION ALL
        SELECT player_id
          FROM trade_drop_reservations
         WHERE trade_id = p_trade_id
      ) AS touched
     WHERE player_id IS NOT NULL
     ORDER BY player_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext(v_trade.league_id::text),
      hashtext(v_lock_player_id::text)
    );
  END LOOP;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_trade.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Trades require an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_trade.league_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trades require the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := CASE
      WHEN v_item.side = 'proposer' THEN v_trade.proposer_member_id
      ELSE v_trade.recipient_member_id
    END;

    IF v_item.player_id IS NOT NULL THEN
      PERFORM 1
        FROM roster_players
       WHERE league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = v_from_member
         AND player_id = v_item.player_id
         AND is_on_ir = false
         AND is_on_taxi = false
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Player asset is no longer owned by the expected active roster side'
          USING ERRCODE = 'PT001';
      END IF;
    ELSE
      PERFORM 1
        FROM draft_picks
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Draft-pick asset is no longer owned by the expected trade side'
          USING ERRCODE = 'PT001';
      END IF;
    END IF;
  END LOOP;

  FOR v_drop IN
    SELECT *
      FROM trade_drop_reservations
     WHERE trade_id = p_trade_id
     ORDER BY player_id ASC
     FOR UPDATE
  LOOP
    DELETE FROM trade_drop_reservations
     WHERE id = v_drop.id;

    DELETE FROM roster_players
     WHERE id = v_drop.roster_player_id
       AND league_id = v_trade.league_id
       AND league_season_id = v_trade.league_season_id
       AND member_id = v_drop.member_id
       AND player_id = v_drop.player_id;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Reserved drop player is no longer on the expected roster.'
        USING ERRCODE = 'PT001';
    END IF;

    DELETE FROM weekly_lineups AS wl
     WHERE wl.league_id = v_trade.league_id
       AND wl.league_season_id = v_trade.league_season_id
       AND wl.member_id = v_drop.member_id
       AND wl.player_id = v_drop.player_id
       AND wl.game_date >= (now() AT TIME ZONE 'America/New_York')::date
       AND NOT EXISTS (
         SELECT 1
           FROM players AS p
           JOIN nba_games AS g
             ON g.game_date = wl.game_date
            AND (g.home_team = p.nba_team OR g.away_team = p.nba_team)
          WHERE p.id = wl.player_id
            AND (
              g.status IN ('InProgress', 'Final')
              OR (g.game_time IS NOT NULL AND g.game_time <= now())
              OR (g.started_at IS NOT NULL AND g.started_at <= now())
            )
       );

    INSERT INTO waiver_wire_log (
      league_id,
      league_season_id,
      player_id,
      dropped_by_member_id,
      clears_at
    )
    VALUES (
      v_trade.league_id,
      v_trade.league_season_id,
      v_drop.player_id,
      v_drop.member_id,
      now() + interval '48 hours'
    );

    INSERT INTO roster_transactions (
      league_id,
      league_season_id,
      member_id,
      player_id,
      transaction_type
    )
    VALUES (
      v_trade.league_id,
      v_trade.league_season_id,
      v_drop.member_id,
      v_drop.player_id,
      'fa_drop'
    );
  END LOOP;

  DELETE FROM weekly_lineups AS wl
   WHERE wl.league_id = v_trade.league_id
     AND wl.league_season_id = v_trade.league_season_id
     AND wl.game_date >= (now() AT TIME ZONE 'America/New_York')::date
     AND wl.player_id IN (
       SELECT ti.player_id
         FROM trade_items AS ti
        WHERE ti.trade_id = p_trade_id
          AND ti.player_id IS NOT NULL
     )
     AND NOT EXISTS (
       SELECT 1
         FROM players AS p
         JOIN nba_games AS g
           ON g.game_date = wl.game_date
          AND (g.home_team = p.nba_team OR g.away_team = p.nba_team)
        WHERE p.id = wl.player_id
          AND (
            g.status IN ('InProgress', 'Final')
            OR (g.game_time IS NOT NULL AND g.game_time <= now())
            OR (g.started_at IS NOT NULL AND g.started_at <= now())
          )
     );

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := CASE
      WHEN v_item.side = 'proposer' THEN v_trade.proposer_member_id
      ELSE v_trade.recipient_member_id
    END;
    v_to_member := CASE
      WHEN v_item.side = 'proposer' THEN v_trade.recipient_member_id
      ELSE v_trade.proposer_member_id
    END;

    IF v_item.player_id IS NOT NULL THEN
      UPDATE roster_players
         SET member_id = v_to_member,
             acquired_via = 'trade'
       WHERE league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = v_from_member
         AND player_id = v_item.player_id
         AND is_on_ir = false
         AND is_on_taxi = false;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Failed to move player asset atomically'
          USING ERRCODE = 'PT001';
      END IF;

      INSERT INTO roster_transactions (
        league_id,
        league_season_id,
        member_id,
        player_id,
        transaction_type,
        related_trade_id
      )
      VALUES
        (v_trade.league_id, v_trade.league_season_id, v_from_member, v_item.player_id, 'trade_out', p_trade_id),
        (v_trade.league_id, v_trade.league_season_id, v_to_member, v_item.player_id, 'trade_in', p_trade_id);
    ELSE
      UPDATE draft_picks
         SET current_owner_id = v_to_member
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Failed to move draft-pick asset atomically'
          USING ERRCODE = 'PT001';
      END IF;
    END IF;
  END LOOP;

  FOR v_to_member IN
    SELECT v_trade.proposer_member_id
    UNION
    SELECT v_trade.recipient_member_id
  LOOP
    SELECT count(*)
      INTO v_active_count
      FROM roster_players
     WHERE league_id = v_trade.league_id
       AND league_season_id = v_trade.league_season_id
       AND member_id = v_to_member
       AND is_on_ir = false
       AND is_on_taxi = false;

    IF v_active_count > COALESCE(v_league.roster_size, 0) THEN
      RAISE EXCEPTION 'Trade completion would overfill a roster.'
        USING ERRCODE = 'PT001';
    END IF;
  END LOOP;

  DELETE FROM trade_drop_reservations WHERE trade_id = p_trade_id;

  UPDATE trades
     SET status = 'completed',
         completed_at = now(),
         completion_failure_reason = NULL
   WHERE id = p_trade_id
     AND status = 'accepted';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to complete trade atomically';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.process_due_accepted_trades_atomic(
  p_limit int DEFAULT 50
)
RETURNS TABLE (
  trade_id uuid,
  proposer_member_id uuid,
  recipient_member_id uuid,
  status text,
  error_code text,
  error_message text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 0), 200);
  v_trade record;
  v_error_code text;
  v_error_message text;
BEGIN
  FOR v_trade IN
    SELECT
      trade.id,
      trade.proposer_member_id,
      trade.recipient_member_id
    FROM public.trades AS trade
    JOIN public.league_seasons AS season
      ON season.id = trade.league_season_id
    JOIN public.leagues AS league
      ON league.id = trade.league_id
    WHERE trade.status = 'accepted'::public.trade_status
      AND trade.veto_window_expires_at <= now()
      AND season.is_current = true
      AND league.status IN ('active'::public.league_status, 'playoffs'::public.league_status)
    ORDER BY trade.veto_window_expires_at, trade.proposed_at, trade.id
    LIMIT v_limit
    FOR UPDATE OF trade SKIP LOCKED
  LOOP
    BEGIN
      PERFORM public.complete_accepted_trade_atomic(v_trade.id);

      RETURN QUERY
      SELECT
        v_trade.id,
        v_trade.proposer_member_id,
        v_trade.recipient_member_id,
        'completed'::text,
        NULL::text,
        NULL::text;
    EXCEPTION WHEN OTHERS THEN
      v_error_code := SQLSTATE;
      v_error_message := SQLERRM;

      IF v_error_code = 'PT001' THEN
        PERFORM public.expire_trade_completion_failure_atomic(v_trade.id, v_error_message);

        RETURN QUERY
        SELECT
          v_trade.id,
          v_trade.proposer_member_id,
          v_trade.recipient_member_id,
          'expired_terminal_failure'::text,
          v_error_code,
          v_error_message;
      ELSE
        RETURN QUERY
        SELECT
          v_trade.id,
          v_trade.proposer_member_id,
          v_trade.recipient_member_id,
          'failed_retryable'::text,
          v_error_code,
          v_error_message;
      END IF;
    END;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.generate_playoff_bracket_atomic(
  p_league_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_season_id uuid;
  v_season_year int;
  v_playoff_start_week int;
  v_member_count int;
  v_playoff_size int;
  v_last_week int;
  v_seed_ids uuid[];
  v_inserted_count int := 0;
  v_pair record;
  v_existing_challenge public.rps_challenges%ROWTYPE;
BEGIN
  SELECT season.id, season.season_year, COALESCE(league.playoff_start_week, 20)
    INTO v_season_id, v_season_year, v_playoff_start_week
    FROM public.league_seasons AS season
    JOIN public.leagues AS league
      ON league.id = season.league_id
   WHERE season.league_id = p_league_id
     AND season.is_current = true
   FOR UPDATE OF season, league;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current league season not found for playoff generation.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'), hashtext(v_season_id::text));

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type IN ('playoff_quarterfinal'::public.matchup_type, 'playoff_semifinal'::public.matchup_type)
   FOR UPDATE;

  IF FOUND THEN
    RETURN jsonb_build_object('inserted', 0, 'skipped', true);
  END IF;

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type = 'regular_season'::public.matchup_type
     AND matchup.week_number < v_playoff_start_week
     AND matchup.is_finalized = false
   FOR UPDATE;

  IF FOUND THEN
    RAISE EXCEPTION 'Regular season matchups must be finalized before generating playoffs.';
  END IF;

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type = 'regular_season'::public.matchup_type
     AND matchup.week_number < v_playoff_start_week
     AND matchup.is_finalized = true
   FOR UPDATE;

  SELECT count(*)
    INTO v_member_count
    FROM public.league_members AS member
   WHERE member.league_id = p_league_id;

  IF v_member_count < 4 THEN
    RAISE EXCEPTION 'Not enough teams to seed playoffs (need 4).';
  END IF;

  v_playoff_size := CASE WHEN v_member_count >= 10 THEN 6 ELSE 4 END;

  SELECT max(week_number)
    INTO v_last_week
    FROM public.season_weeks
   WHERE season_year = v_season_year;

  IF COALESCE(v_last_week, 0) < v_playoff_start_week + (CASE WHEN v_playoff_size >= 6 THEN 3 ELSE 2 END) - 1 THEN
    RAISE EXCEPTION 'Playoff start week does not leave enough season weeks for every playoff round.';
  END IF;

  WITH member_stats AS (
    SELECT
      member.id AS member_id,
      count(*) FILTER (WHERE matchup.winner_member_id = member.id) AS wins,
      COALESCE(sum(CASE
        WHEN matchup.home_member_id = member.id THEN matchup.home_points
        WHEN matchup.away_member_id = member.id THEN matchup.away_points
        ELSE 0
      END), 0) AS points_for,
      COALESCE(sum(CASE
        WHEN matchup.home_member_id = member.id THEN matchup.home_max_possible_points
        WHEN matchup.away_member_id = member.id THEN matchup.away_max_possible_points
        ELSE 0
      END), 0) AS max_possible_points,
      COALESCE(sum(CASE
        WHEN matchup.home_member_id = member.id THEN matchup.away_points
        WHEN matchup.away_member_id = member.id THEN matchup.home_points
        ELSE 0
      END), 0) AS points_against,
      encode(digest((v_season_id::text || ':' || member.id::text)::bytea, 'sha256'), 'hex') AS tie_token
    FROM public.league_members AS member
    LEFT JOIN public.matchups AS matchup
      ON matchup.league_season_id = v_season_id
     AND matchup.matchup_type = 'regular_season'::public.matchup_type
     AND matchup.week_number < v_playoff_start_week
     AND matchup.is_finalized = true
     AND member.id IN (matchup.home_member_id, matchup.away_member_id)
    WHERE member.league_id = p_league_id
    GROUP BY member.id
  )
  SELECT array_agg(member_id ORDER BY wins DESC, points_for DESC, max_possible_points DESC, points_against ASC, tie_token ASC, member_id ASC)
    INTO v_seed_ids
    FROM member_stats;

  FOR v_pair IN
    WITH member_stats AS (
      SELECT
        member.id AS member_id,
        count(*) FILTER (WHERE matchup.winner_member_id = member.id) AS wins,
        COALESCE(sum(CASE
          WHEN matchup.home_member_id = member.id THEN matchup.home_points
          WHEN matchup.away_member_id = member.id THEN matchup.away_points
          ELSE 0
        END), 0) AS points_for,
        COALESCE(sum(CASE
          WHEN matchup.home_member_id = member.id THEN matchup.home_max_possible_points
          WHEN matchup.away_member_id = member.id THEN matchup.away_max_possible_points
          ELSE 0
        END), 0) AS max_possible_points,
        COALESCE(sum(CASE
          WHEN matchup.home_member_id = member.id THEN matchup.away_points
          WHEN matchup.away_member_id = member.id THEN matchup.home_points
          ELSE 0
        END), 0) AS points_against,
        encode(digest((v_season_id::text || ':' || member.id::text)::bytea, 'sha256'), 'hex') AS tie_token
      FROM public.league_members AS member
      LEFT JOIN public.matchups AS matchup
        ON matchup.league_season_id = v_season_id
       AND matchup.matchup_type = 'regular_season'::public.matchup_type
       AND matchup.week_number < v_playoff_start_week
       AND matchup.is_finalized = true
       AND member.id IN (matchup.home_member_id, matchup.away_member_id)
      WHERE member.league_id = p_league_id
      GROUP BY member.id
    ),
    ranked AS (
      SELECT
        member_stats.*,
        row_number() OVER (ORDER BY wins DESC, points_for DESC, max_possible_points DESC, points_against ASC, tie_token ASC, member_id ASC) AS seed_rank
      FROM member_stats
    ),
    seeds AS (
      SELECT
        ranked.*,
        min(seed_rank) OVER (
          PARTITION BY wins, points_for, max_possible_points, points_against
        ) AS group_start
      FROM ranked
    )
    SELECT
      a.member_id AS member_a_id,
      b.member_id AS member_b_id,
      CASE
        WHEN a.tie_token < b.tie_token OR (a.tie_token = b.tie_token AND a.member_id < b.member_id) THEN a.member_id
        ELSE b.member_id
      END AS winner_member_id
    FROM seeds AS a
    JOIN seeds AS b
      ON b.seed_rank > a.seed_rank
     AND b.wins = a.wins
     AND b.points_for = a.points_for
     AND b.max_possible_points = a.max_possible_points
     AND b.points_against = a.points_against
    WHERE a.group_start <= v_playoff_size
  LOOP
    SELECT *
      INTO v_existing_challenge
      FROM public.rps_challenges AS challenge
     WHERE challenge.league_id = p_league_id
       AND challenge.league_season_id = v_season_id
       AND challenge.context = 'standings_playoff_tiebreaker'
       AND LEAST(challenge.member_a_id, challenge.member_b_id) = LEAST(v_pair.member_a_id, v_pair.member_b_id)
       AND GREATEST(challenge.member_a_id, challenge.member_b_id) = GREATEST(v_pair.member_a_id, v_pair.member_b_id)
     FOR UPDATE;

    IF FOUND THEN
      UPDATE public.rps_challenges
         SET winner_member_id = v_pair.winner_member_id,
             member_a_choice = NULL,
             member_b_choice = NULL,
             status = 'completed'::public.rps_status,
             resolved_at = now()
       WHERE id = v_existing_challenge.id;
    ELSE
      INSERT INTO public.rps_challenges (
        league_id,
        league_season_id,
        member_a_id,
        member_b_id,
        winner_member_id,
        status,
        context,
        resolved_at
      )
      VALUES (
        p_league_id,
        v_season_id,
        v_pair.member_a_id,
        v_pair.member_b_id,
        v_pair.winner_member_id,
        'completed'::public.rps_status,
        'standings_playoff_tiebreaker',
        now()
      );
    END IF;
  END LOOP;

  IF v_playoff_size >= 6 THEN
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
        (p_league_id, v_season_id, v_playoff_start_week, 'playoff_quarterfinal'::public.matchup_type, v_seed_ids[3], v_seed_ids[6]),
        (p_league_id, v_season_id, v_playoff_start_week, 'playoff_quarterfinal'::public.matchup_type, v_seed_ids[4], v_seed_ids[5])
      ON CONFLICT (league_id, league_season_id, week_number, home_member_id, away_member_id)
      DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO v_inserted_count FROM inserted;
  ELSE
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
        (p_league_id, v_season_id, v_playoff_start_week, 'playoff_semifinal'::public.matchup_type, v_seed_ids[1], v_seed_ids[4]),
        (p_league_id, v_season_id, v_playoff_start_week, 'playoff_semifinal'::public.matchup_type, v_seed_ids[2], v_seed_ids[3])
      ON CONFLICT (league_id, league_season_id, week_number, home_member_id, away_member_id)
      DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO v_inserted_count FROM inserted;
  END IF;

  RETURN jsonb_build_object('inserted', v_inserted_count, 'skipped', false);
END;
$$;

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
  v_playoff_start_week int;
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
  SELECT season.id, COALESCE(league.playoff_start_week, 20)
    INTO v_season_id, v_playoff_start_week
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

    WITH member_stats AS (
      SELECT
        member.id AS member_id,
        count(*) FILTER (WHERE matchup.winner_member_id = member.id) AS wins,
        COALESCE(sum(CASE
          WHEN matchup.home_member_id = member.id THEN matchup.home_points
          WHEN matchup.away_member_id = member.id THEN matchup.away_points
          ELSE 0
        END), 0) AS points_for,
        COALESCE(sum(CASE
          WHEN matchup.home_member_id = member.id THEN matchup.home_max_possible_points
          WHEN matchup.away_member_id = member.id THEN matchup.away_max_possible_points
          ELSE 0
        END), 0) AS max_possible_points,
        COALESCE(sum(CASE
          WHEN matchup.home_member_id = member.id THEN matchup.away_points
          WHEN matchup.away_member_id = member.id THEN matchup.home_points
          ELSE 0
        END), 0) AS points_against,
        encode(digest((v_season_id::text || ':' || member.id::text)::bytea, 'sha256'), 'hex') AS tie_token
      FROM public.league_members AS member
      LEFT JOIN public.matchups AS matchup
        ON matchup.league_season_id = v_season_id
       AND matchup.matchup_type = 'regular_season'::public.matchup_type
       AND matchup.week_number < v_quarterfinal_week
       AND matchup.is_finalized = true
       AND member.id IN (matchup.home_member_id, matchup.away_member_id)
      WHERE member.league_id = p_league_id
      GROUP BY member.id
    )
    SELECT array_agg(member_id ORDER BY wins DESC, points_for DESC, max_possible_points DESC, points_against ASC, tie_token ASC, member_id ASC)
      INTO v_seed_ids
      FROM member_stats;

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

CREATE OR REPLACE FUNCTION public.invoke_edge_function(
  function_name text,
  body jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _base_url text;
  _internal_token text;
BEGIN
  _base_url := COALESCE(
    NULLIF(current_setting('app.supabase_url', true), ''),
    'https://ceeytbfmwsnzalxlkalc.supabase.co'
  );
  _internal_token := NULLIF(current_setting('app.edge_internal_token', true), '');

  IF _internal_token IS NULL THEN
    SELECT NULLIF(decrypted_secret, '')
      INTO _internal_token
      FROM vault.decrypted_secrets
     WHERE name = 'pancake_edge_internal_token'
     ORDER BY updated_at DESC NULLS LAST, created_at DESC
     LIMIT 1;
  END IF;

  IF _base_url IS NULL THEN
    RAISE EXCEPTION '[cron] Supabase Edge base URL is not configured.';
  END IF;

  IF _internal_token IS NULL THEN
    RAISE EXCEPTION '[cron] Supabase Edge internal token is not configured.';
  END IF;

  PERFORM net.http_post(
    _base_url || '/functions/v1/' || function_name,
    body,
    NULL,
    jsonb_build_object(
      'x-internal-function-token', _internal_token,
      'Content-Type', 'application/json'
    ),
    30000
  );
END;
$$;

DROP FUNCTION IF EXISTS public.insert_playoff_matchups_atomic(uuid, uuid, jsonb, jsonb, jsonb);

REVOKE ALL ON FUNCTION public.expire_trade_completion_failure_atomic(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_trade_completion_failure_atomic(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.expire_trade_completion_failure_atomic(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.expire_trade_completion_failure_atomic(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.reject_trade_atomic(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_trade_atomic(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.reject_trade_atomic(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reject_trade_atomic(uuid, uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.withdraw_trade_atomic(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.withdraw_trade_atomic(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.withdraw_trade_atomic(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_trade_atomic(uuid, uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.complete_accepted_trade_atomic(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_accepted_trade_atomic(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.complete_accepted_trade_atomic(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_accepted_trade_atomic(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.process_due_accepted_trades_atomic(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_due_accepted_trades_atomic(int) FROM anon;
REVOKE ALL ON FUNCTION public.process_due_accepted_trades_atomic(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.process_due_accepted_trades_atomic(int) TO service_role;

REVOKE ALL ON FUNCTION public.generate_playoff_bracket_atomic(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_playoff_bracket_atomic(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.generate_playoff_bracket_atomic(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.generate_playoff_bracket_atomic(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.advance_playoff_bracket_atomic(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.advance_playoff_bracket_atomic(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.advance_playoff_bracket_atomic(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.advance_playoff_bracket_atomic(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.invoke_edge_function(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_edge_function(text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.invoke_edge_function(text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_edge_function(text, jsonb) TO service_role;

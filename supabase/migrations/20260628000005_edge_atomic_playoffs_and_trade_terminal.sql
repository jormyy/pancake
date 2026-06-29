-- Finish the Edge cutover hardening:
-- - playoff bracket decisions and writes live in one SQL transaction
-- - trade completion only terminalizes explicit domain-drift failures
-- - reject/withdraw trade terminal states live behind service-role RPCs

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

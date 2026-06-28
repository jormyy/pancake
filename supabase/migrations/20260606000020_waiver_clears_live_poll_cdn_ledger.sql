CREATE OR REPLACE FUNCTION public.process_next_waiver_claim_atomic(
  p_process_date date
)
RETURNS TABLE (
  processed boolean,
  claim_id uuid,
  member_id uuid,
  player_id uuid,
  status waiver_claim_status,
  failure_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim waiver_claims%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_waiver_log_id uuid;
  v_roster_size int;
  v_active_count int;
  v_projected_active_count int;
  v_drop_roster_id uuid;
  v_max_priority int;
  v_failure text;
  v_lock_player_id uuid;
  v_target_league_id uuid;
  v_target_season_id uuid;
  v_ineligible text;
BEGIN
  SELECT wc.league_id, wc.league_season_id
    INTO v_target_league_id, v_target_season_id
    FROM waiver_claims AS wc
    JOIN waiver_priorities AS wp
      ON wp.league_id = wc.league_id
     AND wp.league_season_id = wc.league_season_id
     AND wp.member_id = wc.member_id
    JOIN waiver_wire_log AS due_wwl
      ON due_wwl.league_id = wc.league_id
     AND due_wwl.league_season_id = wc.league_season_id
     AND due_wwl.player_id = wc.player_id
     AND due_wwl.cleared_at IS NULL
     AND due_wwl.clears_at <= now()
    JOIN leagues AS claim_league
      ON claim_league.id = wc.league_id
     AND claim_league.status IN ('active'::league_status, 'playoffs'::league_status)
    JOIN league_seasons AS claim_season
      ON claim_season.id = wc.league_season_id
     AND claim_season.is_current = true
   WHERE wc.status = 'pending'
   ORDER BY wc.league_id, wc.league_season_id, wp.priority, wc.submitted_at, wc.id
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_target_league_id::text),
    hashtext(v_target_season_id::text)
  );

  PERFORM 1
    FROM waiver_priorities AS wp_lock
   WHERE wp_lock.league_id = v_target_league_id
     AND wp_lock.league_season_id = v_target_season_id
   ORDER BY wp_lock.priority
   FOR UPDATE;

  SELECT wc.*
    INTO v_claim
    FROM waiver_claims AS wc
    JOIN waiver_priorities AS wp
      ON wp.league_id = wc.league_id
     AND wp.league_season_id = wc.league_season_id
     AND wp.member_id = wc.member_id
    JOIN waiver_wire_log AS due_wwl
      ON due_wwl.league_id = wc.league_id
     AND due_wwl.league_season_id = wc.league_season_id
     AND due_wwl.player_id = wc.player_id
     AND due_wwl.cleared_at IS NULL
     AND due_wwl.clears_at <= now()
    JOIN leagues AS claim_league
      ON claim_league.id = wc.league_id
     AND claim_league.status IN ('active'::league_status, 'playoffs'::league_status)
    JOIN league_seasons AS claim_season
      ON claim_season.id = wc.league_season_id
     AND claim_season.is_current = true
   WHERE wc.status = 'pending'
     AND wc.league_id = v_target_league_id
     AND wc.league_season_id = v_target_season_id
   ORDER BY wp.priority, wc.submitted_at, wc.id
   LIMIT 1
   FOR UPDATE OF wc;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_claim.league_id::text),
    hashtext(v_claim.member_id::text)
  );

  -- Now that the winning claim is locked, take advisory locks on every
  -- (league_id, player_id) we are about to mutate. Order by player_id ASC
  -- against the canonical ordering used by accept_trade_atomic and
  -- complete_accepted_trade_atomic so concurrent RPCs touching the same
  -- player(s) acquire locks in the same order.
  FOR v_lock_player_id IN
    SELECT DISTINCT pid
      FROM unnest(
        ARRAY[v_claim.player_id, v_claim.drop_player_id]::uuid[]
      ) AS t(pid)
     WHERE pid IS NOT NULL
     ORDER BY pid ASC
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext(v_claim.league_id::text),
      hashtext(v_lock_player_id::text)
    );
  END LOOP;

  SELECT wwl.id
    INTO v_waiver_log_id
    FROM waiver_wire_log AS wwl
   WHERE wwl.league_id = v_claim.league_id
     AND wwl.league_season_id = v_claim.league_season_id
     AND wwl.player_id = v_claim.player_id
     AND wwl.cleared_at IS NULL
     AND wwl.clears_at <= now()
   ORDER BY wwl.clears_at
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    v_failure := 'Player no longer on waivers.';
    UPDATE waiver_claims AS wc_update
       SET status = 'failed_priority',
           processed_at = now(),
           failure_reason = v_failure
     WHERE wc_update.id = v_claim.id;

    RETURN QUERY
      SELECT true, v_claim.id, v_claim.member_id, v_claim.player_id, 'failed_priority'::waiver_claim_status, v_failure;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM roster_players AS rp
     WHERE rp.league_id = v_claim.league_id
       AND rp.league_season_id = v_claim.league_season_id
       AND rp.player_id = v_claim.player_id
     FOR UPDATE
  ) THEN
    v_failure := 'Player already on a roster.';
    UPDATE waiver_claims AS wc_update
       SET status = 'failed_priority',
           processed_at = now(),
           failure_reason = v_failure
     WHERE wc_update.id = v_claim.id;

    RETURN QUERY
      SELECT true, v_claim.id, v_claim.member_id, v_claim.player_id, 'failed_priority'::waiver_claim_status, v_failure;
    RETURN;
  END IF;

  -- Lock the leagues row and gate on status. Widens the prior partial
  -- `SELECT l.roster_size` into the full v_league row so status is
  -- available without an extra round-trip. Waivers only process while the
  -- season is in-flight ('active' / 'playoffs').
  SELECT *
    INTO v_league
    FROM leagues AS l
   WHERE l.id = v_claim.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Waivers require an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_claim.league_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Waivers require the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  v_roster_size := v_league.roster_size;

  SELECT string_agg(COALESCE(p.display_name, 'Unknown'), ', ')
    INTO v_ineligible
    FROM roster_players AS rp
    JOIN players AS p ON p.id = rp.player_id
   WHERE rp.member_id = v_claim.member_id
     AND rp.league_id = v_claim.league_id
     AND rp.league_season_id = v_claim.league_season_id
     AND rp.is_on_ir = true
     AND NOT (
       lower(COALESCE(p.injury_status, '')) = 'out'
       OR lower(COALESCE(p.injury_status, '')) LIKE 'ir%'
     );

  IF v_ineligible IS NOT NULL AND length(v_ineligible) > 0 THEN
    v_failure := format(
      'You have ineligible players on IR (%s). Activate or drop them before waiver claims can process.',
      v_ineligible
    );
    UPDATE waiver_claims AS wc_update
       SET status = 'failed_roster',
           processed_at = now(),
           failure_reason = v_failure
     WHERE wc_update.id = v_claim.id;

    RETURN QUERY
      SELECT true, v_claim.id, v_claim.member_id, v_claim.player_id, 'failed_roster'::waiver_claim_status, v_failure;
    RETURN;
  END IF;

  SELECT count(*)
    INTO v_active_count
    FROM roster_players AS rp
   WHERE rp.league_id = v_claim.league_id
     AND rp.league_season_id = v_claim.league_season_id
     AND rp.member_id = v_claim.member_id
     AND rp.is_on_ir = false
     AND rp.is_on_taxi = false;

  v_projected_active_count := v_active_count + 1 - CASE WHEN v_claim.drop_player_id IS NULL THEN 0 ELSE 1 END;

  IF v_projected_active_count > COALESCE(v_roster_size, 20) THEN
    v_failure := CASE
      WHEN v_claim.drop_player_id IS NULL THEN 'Roster full and no drop player specified.'
      ELSE 'Waiver claim would leave your active roster over the limit.'
    END;
    UPDATE waiver_claims AS wc_update
       SET status = 'failed_roster',
           processed_at = now(),
           failure_reason = v_failure
     WHERE wc_update.id = v_claim.id;

    RETURN QUERY
      SELECT true, v_claim.id, v_claim.member_id, v_claim.player_id, 'failed_roster'::waiver_claim_status, v_failure;
    RETURN;
  END IF;

  IF v_claim.drop_player_id IS NOT NULL THEN
    SELECT rp.id
      INTO v_drop_roster_id
      FROM roster_players AS rp
     WHERE rp.league_id = v_claim.league_id
       AND rp.league_season_id = v_claim.league_season_id
       AND rp.member_id = v_claim.member_id
       AND rp.player_id = v_claim.drop_player_id
       AND rp.is_on_ir = false
       AND rp.is_on_taxi = false
     FOR UPDATE;

    IF NOT FOUND THEN
      v_failure := 'Drop player is no longer on this active roster.';
      UPDATE waiver_claims AS wc_update
         SET status = 'failed_roster',
             processed_at = now(),
             failure_reason = v_failure
       WHERE wc_update.id = v_claim.id;

      RETURN QUERY
        SELECT true, v_claim.id, v_claim.member_id, v_claim.player_id, 'failed_roster'::waiver_claim_status, v_failure;
      RETURN;
    END IF;

    IF EXISTS (
      SELECT 1
        FROM trade_drop_reservations AS reservation
        JOIN trades AS trade
          ON trade.id = reservation.trade_id
         AND trade.status = 'accepted'::trade_status
       WHERE reservation.roster_player_id = v_drop_roster_id
    ) OR EXISTS (
      SELECT 1
        FROM trade_items AS item
        JOIN trades AS trade
          ON trade.id = item.trade_id
         AND trade.status = 'accepted'::trade_status
       WHERE item.player_id = v_claim.drop_player_id
         AND trade.league_id = v_claim.league_id
         AND trade.league_season_id = v_claim.league_season_id
         AND (
           (item.side = 'proposer' AND trade.proposer_member_id = v_claim.member_id)
           OR (item.side = 'recipient' AND trade.recipient_member_id = v_claim.member_id)
         )
    ) THEN
      v_failure := 'Drop player is reserved for an accepted trade.';
      UPDATE waiver_claims AS wc_update
         SET status = 'failed_roster',
             processed_at = now(),
             failure_reason = v_failure
       WHERE wc_update.id = v_claim.id;

      RETURN QUERY
        SELECT true, v_claim.id, v_claim.member_id, v_claim.player_id, 'failed_roster'::waiver_claim_status, v_failure;
      RETURN;
    END IF;

    DELETE FROM roster_players AS rp
     WHERE rp.id = v_drop_roster_id;

    -- Clear weekly_lineups for the dropped player so the scorer cannot
    -- continue to credit the dropping member after the row is gone.
    DELETE FROM weekly_lineups AS wl
     WHERE wl.league_id = v_claim.league_id
       AND wl.league_season_id = v_claim.league_season_id
       AND wl.member_id = v_claim.member_id
       AND wl.player_id = v_claim.drop_player_id
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
      v_claim.league_id,
      v_claim.league_season_id,
      v_claim.drop_player_id,
      v_claim.member_id,
      now() + interval '48 hours'
    );

    INSERT INTO roster_transactions (
      league_id,
      league_season_id,
      member_id,
      player_id,
      transaction_type,
      related_claim_id
    )
    VALUES (
      v_claim.league_id,
      v_claim.league_season_id,
      v_claim.member_id,
      v_claim.drop_player_id,
      'waiver_drop',
      v_claim.id
    );
  END IF;

  -- Clear any weekly_lineups rows for the incoming player. He was on
  -- waivers, but a prior owner (whose roster row was already removed when
  -- they dropped him) may have left lineup rows behind that pre-date this
  -- migration. Defensive: keep the scorer from ever seeing two members
  -- credited for the same incoming player on the same day.
  DELETE FROM weekly_lineups AS wl
   WHERE wl.league_id = v_claim.league_id
     AND wl.league_season_id = v_claim.league_season_id
     AND wl.player_id = v_claim.player_id
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

  INSERT INTO roster_players (
    league_id,
    league_season_id,
    member_id,
    player_id,
    acquired_via
  )
  VALUES (
    v_claim.league_id,
    v_claim.league_season_id,
    v_claim.member_id,
    v_claim.player_id,
    'waiver'
  );

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type,
    related_claim_id
  )
  VALUES (
    v_claim.league_id,
    v_claim.league_season_id,
    v_claim.member_id,
    v_claim.player_id,
    'waiver_add',
    v_claim.id
  );

  UPDATE waiver_wire_log AS wwl_update
     SET cleared_at = now(),
         claimed_by_claim_id = v_claim.id
   WHERE wwl_update.id = v_waiver_log_id;

  SELECT max(wp.priority)
    INTO v_max_priority
    FROM waiver_priorities AS wp
   WHERE wp.league_id = v_claim.league_id
     AND wp.league_season_id = v_claim.league_season_id;

  UPDATE waiver_priorities AS wp_update
     SET priority = COALESCE(v_max_priority, 0) + 1
   WHERE wp_update.league_id = v_claim.league_id
     AND wp_update.league_season_id = v_claim.league_season_id
     AND wp_update.member_id = v_claim.member_id;

  UPDATE waiver_claims AS wc_update
     SET status = 'succeeded',
         processed_at = now(),
         failure_reason = NULL
   WHERE wc_update.id = v_claim.id;

  RETURN QUERY
    SELECT true, v_claim.id, v_claim.member_id, v_claim.player_id, 'succeeded'::waiver_claim_status, NULL::text;

  RETURN QUERY
  WITH failed AS (
    UPDATE waiver_claims AS wc_other
     SET status = 'failed_priority',
         processed_at = now(),
         failure_reason = 'Claimed by higher-priority team.'
    WHERE wc_other.status = 'pending'
      AND wc_other.league_id = v_claim.league_id
      AND wc_other.league_season_id = v_claim.league_season_id
      AND wc_other.player_id = v_claim.player_id
      AND wc_other.id <> v_claim.id
    RETURNING wc_other.id, wc_other.member_id, wc_other.player_id, wc_other.status, wc_other.failure_reason
  )
  SELECT true, failed.id, failed.member_id, failed.player_id, failed.status, failed.failure_reason
    FROM failed;
END;
$$;


REVOKE ALL ON FUNCTION public.process_next_waiver_claim_atomic(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_next_waiver_claim_atomic(date) FROM anon;
REVOKE ALL ON FUNCTION public.process_next_waiver_claim_atomic(date) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.process_next_waiver_claim_atomic(date) TO service_role;

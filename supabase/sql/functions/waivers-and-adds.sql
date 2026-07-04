-- Canonical SQL source for waivers and adds.
-- Edit this file first, then copy changed function statements into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies the latest migration definitions still match.

CREATE OR REPLACE FUNCTION private.clear_future_unlocked_lineups(
  p_league_id uuid,
  p_league_season_id uuid,
  p_player_id uuid,
  p_member_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM weekly_lineups AS wl
   WHERE wl.league_id = p_league_id
     AND wl.league_season_id = p_league_season_id
     AND wl.player_id = p_player_id
     AND (p_member_id IS NULL OR wl.member_id = p_member_id)
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
$$;

CREATE OR REPLACE FUNCTION private.clear_trade_block_listing_for_asset(
  p_league_id uuid,
  p_member_id uuid,
  p_player_id uuid DEFAULT NULL,
  p_pick_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM trade_block_items AS item
   WHERE item.league_id = p_league_id
     AND item.member_id = p_member_id
     AND (
       (p_player_id IS NOT NULL AND item.player_id = p_player_id)
       OR (p_pick_id IS NOT NULL AND item.pick_id = p_pick_id)
     );
$$;

CREATE OR REPLACE FUNCTION private.validate_waiver_claim_drop_player(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_drop_player_id uuid,
  p_missing_message text DEFAULT 'Drop player must be on your active roster.'
)
RETURNS TABLE (
  roster_player_id uuid,
  failure_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_roster_player_id uuid;
BEGIN
  IF p_drop_player_id IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text;
    RETURN;
  END IF;

  SELECT rp.id
    INTO v_roster_player_id
    FROM roster_players AS rp
   WHERE rp.member_id = p_member_id
     AND rp.league_id = p_league_id
     AND rp.league_season_id = p_league_season_id
     AND rp.player_id = p_drop_player_id
     AND rp.is_on_ir = false
     AND rp.is_on_taxi = false
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, p_missing_message;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_drop_reservations AS reservation
      JOIN trades AS trade
        ON trade.id = reservation.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE reservation.roster_player_id = v_roster_player_id
  ) OR EXISTS (
    SELECT 1
      FROM trade_items AS item
      JOIN trades AS trade
        ON trade.id = item.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE item.player_id = p_drop_player_id
       AND trade.league_id = p_league_id
       AND trade.league_season_id = p_league_season_id
       AND (
         (item.side = 'proposer' AND trade.proposer_member_id = p_member_id)
         OR (item.side = 'recipient' AND trade.recipient_member_id = p_member_id)
       )
  ) THEN
    RETURN QUERY SELECT v_roster_player_id, 'Drop player is reserved for an accepted trade.';
    RETURN;
  END IF;

  RETURN QUERY SELECT v_roster_player_id, NULL::text;
END;
$$;

CREATE OR REPLACE FUNCTION private.release_roster_player_to_waivers(
  p_roster_player_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_transaction_type text,
  p_related_claim_id uuid DEFAULT NULL,
  p_related_trade_id uuid DEFAULT NULL,
  p_missing_message text DEFAULT 'Roster player is no longer on the expected roster.'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows int;
BEGIN
  DELETE FROM roster_players AS rp
   WHERE rp.id = p_roster_player_id
     AND rp.league_id = p_league_id
     AND rp.league_season_id = p_league_season_id
     AND rp.member_id = p_member_id
     AND rp.player_id = p_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION '%', p_missing_message
      USING ERRCODE = 'PT001';
  END IF;

  PERFORM private.clear_trade_block_listing_for_asset(
    p_league_id,
    p_member_id,
    p_player_id
  );

  PERFORM private.clear_future_unlocked_lineups(
    p_league_id,
    p_league_season_id,
    p_player_id,
    p_member_id
  );

  INSERT INTO waiver_wire_log (
    league_id,
    league_season_id,
    player_id,
    dropped_by_member_id,
    clears_at
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_player_id,
    p_member_id,
    now() + interval '48 hours'
  );

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type,
    related_claim_id,
    related_trade_id
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_member_id,
    p_player_id,
    p_transaction_type,
    p_related_claim_id,
    p_related_trade_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.add_free_agent_atomic(
  p_member_id uuid,
  p_league_id uuid,
  p_player_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league leagues%ROWTYPE;
  v_season_id uuid;
  v_active_count int;
  v_waiver_log_id uuid;
  v_existing_roster_id uuid;
  v_ineligible text;
BEGIN
  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not add player - you may not have permission for this league.'
      USING ERRCODE = '42501';
  END IF;

  SELECT id
    INTO v_season_id
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'No active season found.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text));
  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_player_id::text));

  SELECT string_agg(COALESCE(p.display_name, 'Unknown'), ', ')
    INTO v_ineligible
    FROM roster_players rp
    JOIN players p ON p.id = rp.player_id
   WHERE rp.member_id = p_member_id
     AND rp.league_id = p_league_id
     AND rp.league_season_id = v_season_id
     AND rp.is_on_ir = true
     AND NOT (
       lower(COALESCE(p.injury_status, '')) = 'out'
       OR lower(COALESCE(p.injury_status, '')) LIKE 'ir%'
     );

  IF v_ineligible IS NOT NULL AND length(v_ineligible) > 0 THEN
    RAISE EXCEPTION 'You have ineligible players on IR (%). Activate or drop them before adding players.',
      v_ineligible
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id
    INTO v_waiver_log_id
    FROM waiver_wire_log
   WHERE league_id = p_league_id
     AND league_season_id = v_season_id
     AND player_id = p_player_id
     AND cleared_at IS NULL
     AND clears_at > now()
   ORDER BY clears_at
   LIMIT 1
   FOR UPDATE;

  IF v_waiver_log_id IS NOT NULL THEN
    RAISE EXCEPTION 'This player is on waivers - submit a waiver claim instead.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id
    INTO v_existing_roster_id
    FROM roster_players
   WHERE league_id = p_league_id
     AND league_season_id = v_season_id
     AND player_id = p_player_id
   FOR UPDATE;

  IF v_existing_roster_id IS NOT NULL THEN
    RAISE EXCEPTION 'This player is already on a roster.'
      USING ERRCODE = '23505';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Free-agent adds require an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Free-agent adds require the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM private.assert_weekly_add_available(p_league_id, v_season_id, p_member_id);

  SELECT count(*)
    INTO v_active_count
    FROM roster_players
   WHERE member_id = p_member_id
     AND league_id = p_league_id
     AND league_season_id = v_season_id
     AND is_on_ir = false
     AND is_on_taxi = false;

  IF v_active_count >= COALESCE(v_league.roster_size, 20) THEN
    RAISE EXCEPTION 'Your active roster is full (% players).', COALESCE(v_league.roster_size, 20)
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM private.clear_future_unlocked_lineups(
    p_league_id,
    v_season_id,
    p_player_id
  );

  INSERT INTO roster_players (
    member_id,
    league_id,
    league_season_id,
    player_id,
    acquired_via
  )
  VALUES (
    p_member_id,
    p_league_id,
    v_season_id,
    p_player_id,
    'free_agent'
  );

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type
  )
  VALUES (
    p_league_id,
    v_season_id,
    p_member_id,
    p_player_id,
    'fa_add'
  );

  PERFORM private.consume_weekly_add(p_league_id, v_season_id, p_member_id);

  PERFORM private.log_league_activity(
    p_league_id,
    v_season_id,
    'free_agent_added',
    'Free agent added',
    NULL,
    p_member_id,
    p_member_id,
    p_player_id,
    NULL,
    NULL,
    '{}'::jsonb
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.create_waiver_claim_atomic(
  p_league_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_drop_player_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_bid_amount int DEFAULT 0,
  p_claim_order int DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league leagues%ROWTYPE;
  v_season_id uuid;
  v_priority int;
  v_waiver_log waiver_wire_log%ROWTYPE;
  v_claim_id uuid;
  v_lock_player_id uuid;
  v_drop_failure text;
  v_bid_amount int := COALESCE(p_bid_amount, 0);
  v_claim_order int;
  v_balance int;
BEGIN
  IF v_bid_amount < 0 THEN
    RAISE EXCEPTION 'FAAB bid must be a non-negative integer.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND (p_user_id IS NULL OR user_id = p_user_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied'
      USING ERRCODE = '42501';
  END IF;

  SELECT id
    INTO v_season_id
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   LIMIT 1;

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'No active season found.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(v_season_id::text));

  SELECT priority
    INTO v_priority
    FROM waiver_priorities
   WHERE member_id = p_member_id
     AND league_season_id = v_season_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No waiver priority found for your team.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(p_member_id::text));

  FOR v_lock_player_id IN
    SELECT DISTINCT pid
      FROM unnest(ARRAY[p_player_id, p_drop_player_id]::uuid[]) AS t(pid)
     WHERE pid IS NOT NULL
     ORDER BY pid ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(v_lock_player_id::text));
  END LOOP;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
    RAISE EXCEPTION 'Waiver claims require an active or playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons
   WHERE id = v_season_id
     AND is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season found.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM private.assert_weekly_add_available(p_league_id, v_season_id, p_member_id);

  IF v_league.waiver_mode = 'rolling' THEN
    v_bid_amount := 0;
  ELSE
    v_balance := private.ensure_faab_balance(p_league_id, v_season_id, p_member_id);
    IF v_bid_amount > v_balance THEN
      RAISE EXCEPTION 'FAAB bid exceeds your available balance.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT *
    INTO v_waiver_log
    FROM waiver_wire_log
   WHERE league_id = p_league_id
     AND league_season_id = v_season_id
     AND player_id = p_player_id
     AND cleared_at IS NULL
     AND clears_at > now()
   ORDER BY clears_at
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This player is no longer on waivers.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_drop_player_id IS NOT NULL THEN
    SELECT validation.failure_reason
      INTO v_drop_failure
      FROM private.validate_waiver_claim_drop_player(
        p_league_id,
        v_season_id,
        p_member_id,
        p_drop_player_id
      ) AS validation;

    IF v_drop_failure IS NOT NULL THEN
      RAISE EXCEPTION '%', v_drop_failure
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM waiver_claims
     WHERE member_id = p_member_id
       AND league_season_id = v_season_id
       AND player_id = p_player_id
       AND status = 'pending'
     FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'You already have a pending claim for this player.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(p_claim_order, max(claim_order) + 1, 1)
    INTO v_claim_order
    FROM waiver_claims
   WHERE member_id = p_member_id
     AND league_season_id = v_season_id
     AND status = 'pending';

  INSERT INTO waiver_claims (
    league_id,
    league_season_id,
    member_id,
    player_id,
    drop_player_id,
    priority_at_submission,
    process_date,
    bid_amount,
    claim_order
  )
  VALUES (
    p_league_id,
    v_season_id,
    p_member_id,
    p_player_id,
    p_drop_player_id,
    v_priority,
    (v_waiver_log.clears_at AT TIME ZONE 'America/New_York')::date,
    v_bid_amount,
    v_claim_order
  )
  RETURNING id INTO v_claim_id;

  RETURN v_claim_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.edit_waiver_claim_atomic(
  p_claim_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_drop_player_id uuid DEFAULT NULL,
  p_bid_amount int DEFAULT 0,
  p_claim_order int DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim waiver_claims%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_bid_amount int := COALESCE(p_bid_amount, 0);
  v_balance int;
  v_drop_failure text;
BEGIN
  IF v_bid_amount < 0 THEN
    RAISE EXCEPTION 'FAAB bid must be a non-negative integer.'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_claim
    FROM waiver_claims
   WHERE id = p_claim_id
     AND member_id = p_member_id
     AND status = 'pending'
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending waiver claim not found.'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = v_claim.league_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_claim.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.waiver_mode = 'rolling' THEN
    v_bid_amount := 0;
  ELSE
    v_balance := private.ensure_faab_balance(v_claim.league_id, v_claim.league_season_id, p_member_id);
    IF v_bid_amount > v_balance THEN
      RAISE EXCEPTION 'FAAB bid exceeds your available balance.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_drop_player_id IS NOT NULL THEN
    SELECT validation.failure_reason
      INTO v_drop_failure
      FROM private.validate_waiver_claim_drop_player(
        v_claim.league_id,
        v_claim.league_season_id,
        p_member_id,
        p_drop_player_id
      ) AS validation;

    IF v_drop_failure IS NOT NULL THEN
      RAISE EXCEPTION '%', v_drop_failure
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE waiver_claims
     SET drop_player_id = p_drop_player_id,
         bid_amount = v_bid_amount,
         claim_order = COALESCE(p_claim_order, claim_order),
         submitted_at = now()
   WHERE id = p_claim_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_waiver_claim_atomic(
  p_claim_id uuid,
  p_member_id uuid,
  p_user_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status waiver_claim_status;
  v_rows int;
BEGIN
  SELECT claim.status
    INTO v_status
    FROM waiver_claims AS claim
    JOIN league_members AS member
      ON member.id = claim.member_id
   WHERE claim.id = p_claim_id
     AND claim.member_id = p_member_id
     AND member.user_id = p_user_id
   FOR UPDATE OF claim;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_status <> 'pending'::waiver_claim_status THEN
    RAISE EXCEPTION 'Claim is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE waiver_claims
     SET status = 'cancelled'::waiver_claim_status,
         processed_at = now()
   WHERE id = p_claim_id
     AND status = 'pending'::waiver_claim_status;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Claim is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.reorder_waiver_claim_atomic(
  p_claim_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_direction text
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim waiver_claims%ROWTYPE;
  v_other waiver_claims%ROWTYPE;
BEGIN
  IF p_direction NOT IN ('up', 'down') THEN
    RAISE EXCEPTION 'Direction must be up or down.'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_claim
    FROM waiver_claims
   WHERE id = p_claim_id
     AND member_id = p_member_id
     AND status = 'pending'
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending waiver claim not found.'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = v_claim.league_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.'
      USING ERRCODE = '42501';
  END IF;

  IF p_direction = 'up' THEN
    SELECT *
      INTO v_other
      FROM waiver_claims
     WHERE member_id = p_member_id
       AND league_season_id = v_claim.league_season_id
       AND status = 'pending'
       AND bid_amount = v_claim.bid_amount
       AND claim_order < v_claim.claim_order
     ORDER BY claim_order DESC, submitted_at DESC
     LIMIT 1
     FOR UPDATE;
  ELSE
    SELECT *
      INTO v_other
      FROM waiver_claims
     WHERE member_id = p_member_id
       AND league_season_id = v_claim.league_season_id
       AND status = 'pending'
       AND bid_amount = v_claim.bid_amount
       AND claim_order > v_claim.claim_order
     ORDER BY claim_order ASC, submitted_at ASC
     LIMIT 1
     FOR UPDATE;
  END IF;

  IF FOUND THEN
    UPDATE waiver_claims
       SET claim_order = v_other.claim_order
     WHERE id = v_claim.id;

    UPDATE waiver_claims
       SET claim_order = v_claim.claim_order
     WHERE id = v_other.id;

    RETURN v_other.claim_order;
  END IF;

  RETURN v_claim.claim_order;
END;
$$;

CREATE OR REPLACE FUNCTION private.fail_waiver_claim(
  p_claim_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_status waiver_claim_status,
  p_failure_reason text,
  p_event_type text DEFAULT NULL,
  p_title text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
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
BEGIN
  UPDATE waiver_claims
     SET status = p_status,
         processed_at = now(),
         failure_reason = p_failure_reason
   WHERE id = p_claim_id;

  IF p_event_type IS NOT NULL THEN
    PERFORM private.log_league_activity(
      p_league_id,
      p_league_season_id,
      p_event_type,
      COALESCE(p_title, 'Waiver claim failed'),
      p_failure_reason,
      NULL,
      p_member_id,
      p_player_id,
      NULL,
      p_claim_id,
      COALESCE(p_metadata, '{}'::jsonb)
    );
  END IF;

  RETURN QUERY
    SELECT true, p_claim_id, p_member_id, p_player_id, p_status, p_failure_reason;
END;
$$;

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
  v_target_player_id uuid;
  v_ineligible text;
  v_faab_balance int;
  v_week int;
  v_weekly_add_count int;
  v_player_name text;
  v_candidate record;
BEGIN
  -- Try-lock-and-skip, matching the trade/nomination batch processors: a
  -- league whose advisory lock is held elsewhere is skipped this pass instead
  -- of blocking the cron.
  FOR v_candidate IN
    SELECT candidate.league_id, candidate.league_season_id, candidate.player_id
      FROM waiver_claims AS candidate
      JOIN waiver_priorities AS wp
        ON wp.league_id = candidate.league_id
       AND wp.league_season_id = candidate.league_season_id
       AND wp.member_id = candidate.member_id
      JOIN waiver_wire_log AS due_wwl
        ON due_wwl.league_id = candidate.league_id
       AND due_wwl.league_season_id = candidate.league_season_id
       AND due_wwl.player_id = candidate.player_id
       AND due_wwl.cleared_at IS NULL
       AND due_wwl.clears_at <= now()
      JOIN leagues AS claim_league
        ON claim_league.id = candidate.league_id
       AND claim_league.status IN ('active'::league_status, 'playoffs'::league_status)
      JOIN league_seasons AS claim_season
        ON claim_season.id = candidate.league_season_id
       AND claim_season.is_current = true
     WHERE candidate.status = 'pending'
       AND candidate.process_date <= p_process_date
     ORDER BY
       candidate.league_id,
       candidate.league_season_id,
       CASE WHEN claim_league.waiver_mode = 'faab' THEN candidate.bid_amount END DESC NULLS LAST,
       wp.priority ASC,
       candidate.claim_order ASC,
       candidate.submitted_at ASC,
       candidate.id ASC
  LOOP
    IF pg_try_advisory_xact_lock(hashtext(v_candidate.league_id::text), hashtext(v_candidate.league_season_id::text)) THEN
      v_target_league_id := v_candidate.league_id;
      v_target_season_id := v_candidate.league_season_id;
      v_target_player_id := v_candidate.player_id;
      EXIT;
    END IF;
  END LOOP;

  IF v_target_league_id IS NULL THEN
    RETURN;
  END IF;

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
     AND wc.process_date <= p_process_date
     AND wc.league_id = v_target_league_id
     AND wc.league_season_id = v_target_season_id
     AND wc.player_id = v_target_player_id
   ORDER BY
     CASE WHEN claim_league.waiver_mode = 'faab' THEN wc.bid_amount END DESC NULLS LAST,
     wp.priority ASC,
     wc.claim_order ASC,
     wc.submitted_at ASC,
     wc.id ASC
   LIMIT 1
   FOR UPDATE OF wc;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_claim.league_id::text), hashtext(v_claim.member_id::text));

  FOR v_lock_player_id IN
    SELECT DISTINCT pid
      FROM unnest(ARRAY[v_claim.player_id, v_claim.drop_player_id]::uuid[]) AS t(pid)
     WHERE pid IS NOT NULL
     ORDER BY pid ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_claim.league_id::text), hashtext(v_lock_player_id::text));
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
    RETURN QUERY SELECT * FROM private.fail_waiver_claim(
      v_claim.id,
      v_claim.league_id,
      v_claim.league_season_id,
      v_claim.member_id,
      v_claim.player_id,
      'failed_priority'::waiver_claim_status,
      v_failure
    );
    RETURN;
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_claim.league_id
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

  SELECT display_name
    INTO v_player_name
    FROM players
   WHERE id = v_claim.player_id;

  IF v_league.weekly_add_limit IS NOT NULL THEN
    v_week := private.current_add_week_number(v_claim.league_id, v_claim.league_season_id);

    INSERT INTO weekly_add_counts (
      league_id,
      league_season_id,
      member_id,
      week_number,
      add_count
    )
    VALUES (
      v_claim.league_id,
      v_claim.league_season_id,
      v_claim.member_id,
      v_week,
      0
    )
    ON CONFLICT ON CONSTRAINT weekly_add_counts_league_id_league_season_id_member_id_week_key DO NOTHING;

    SELECT count_row.add_count
      INTO v_weekly_add_count
      FROM weekly_add_counts AS count_row
     WHERE count_row.league_id = v_claim.league_id
       AND count_row.league_season_id = v_claim.league_season_id
       AND count_row.member_id = v_claim.member_id
       AND count_row.week_number = v_week
     FOR UPDATE;

    IF COALESCE(v_weekly_add_count, 0) >= v_league.weekly_add_limit THEN
      v_failure := private.weekly_add_limit_message(COALESCE(v_weekly_add_count, 0), v_league.weekly_add_limit);
      RETURN QUERY SELECT * FROM private.fail_waiver_claim(
        v_claim.id,
        v_claim.league_id,
        v_claim.league_season_id,
        v_claim.member_id,
        v_claim.player_id,
        'failed_roster'::waiver_claim_status,
        v_failure,
        'waiver_claim_failed_add_limit',
        'Waiver claim failed',
        jsonb_build_object('bid_amount', v_claim.bid_amount)
      );
      RETURN;
    END IF;
  END IF;

  IF v_league.waiver_mode = 'faab' THEN
    v_faab_balance := private.ensure_faab_balance(v_claim.league_id, v_claim.league_season_id, v_claim.member_id);
    IF v_faab_balance < v_claim.bid_amount THEN
      v_failure := 'Insufficient FAAB budget for this bid.';
      RETURN QUERY SELECT * FROM private.fail_waiver_claim(
        v_claim.id,
        v_claim.league_id,
        v_claim.league_season_id,
        v_claim.member_id,
        v_claim.player_id,
        'failed_priority'::waiver_claim_status,
        v_failure,
        'faab_bid_failed',
        'FAAB bid failed',
        jsonb_build_object('bid_amount', v_claim.bid_amount)
      );
      RETURN;
    END IF;
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
    RETURN QUERY SELECT * FROM private.fail_waiver_claim(
      v_claim.id,
      v_claim.league_id,
      v_claim.league_season_id,
      v_claim.member_id,
      v_claim.player_id,
      'failed_priority'::waiver_claim_status,
      v_failure
    );
    RETURN;
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
    RETURN QUERY SELECT * FROM private.fail_waiver_claim(
      v_claim.id,
      v_claim.league_id,
      v_claim.league_season_id,
      v_claim.member_id,
      v_claim.player_id,
      'failed_roster'::waiver_claim_status,
      v_failure
    );
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
    RETURN QUERY SELECT * FROM private.fail_waiver_claim(
      v_claim.id,
      v_claim.league_id,
      v_claim.league_season_id,
      v_claim.member_id,
      v_claim.player_id,
      'failed_roster'::waiver_claim_status,
      v_failure
    );
    RETURN;
  END IF;

  IF v_claim.drop_player_id IS NOT NULL THEN
    SELECT validation.roster_player_id, validation.failure_reason
      INTO v_drop_roster_id, v_failure
      FROM private.validate_waiver_claim_drop_player(
        v_claim.league_id,
        v_claim.league_season_id,
        v_claim.member_id,
        v_claim.drop_player_id,
        'Drop player is no longer on this active roster.'
      ) AS validation;

    IF v_failure IS NOT NULL THEN
      RETURN QUERY SELECT * FROM private.fail_waiver_claim(
        v_claim.id,
        v_claim.league_id,
        v_claim.league_season_id,
        v_claim.member_id,
        v_claim.player_id,
        'failed_roster'::waiver_claim_status,
        v_failure
      );
      RETURN;
    END IF;

    PERFORM private.release_roster_player_to_waivers(
      v_drop_roster_id,
      v_claim.league_id,
      v_claim.league_season_id,
      v_claim.member_id,
      v_claim.drop_player_id,
      'waiver_drop',
      v_claim.id
    );
  END IF;

  PERFORM private.clear_future_unlocked_lineups(
    v_claim.league_id,
    v_claim.league_season_id,
    v_claim.player_id
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

  UPDATE waiver_wire_log
     SET cleared_at = now(),
         claimed_by_claim_id = v_claim.id
   WHERE id = v_waiver_log_id;

  IF v_league.waiver_mode = 'faab' THEN
    UPDATE faab_balances AS balance_row
       SET balance = balance_row.balance - v_claim.bid_amount,
           updated_at = now()
     WHERE balance_row.league_id = v_claim.league_id
       AND balance_row.league_season_id = v_claim.league_season_id
       AND balance_row.member_id = v_claim.member_id;
  END IF;

  PERFORM private.consume_weekly_add(v_claim.league_id, v_claim.league_season_id, v_claim.member_id);

  SELECT max(wp.priority)
    INTO v_max_priority
    FROM waiver_priorities AS wp
   WHERE wp.league_id = v_claim.league_id
     AND wp.league_season_id = v_claim.league_season_id;

  UPDATE waiver_priorities AS priority_row
     SET priority = COALESCE(v_max_priority, 0) + 1
   WHERE priority_row.league_id = v_claim.league_id
     AND priority_row.league_season_id = v_claim.league_season_id
     AND priority_row.member_id = v_claim.member_id;

  UPDATE waiver_claims
     SET status = 'succeeded',
         processed_at = now(),
         failure_reason = NULL
   WHERE id = v_claim.id;

  PERFORM private.log_league_activity(
    v_claim.league_id,
    v_claim.league_season_id,
    CASE WHEN v_league.waiver_mode = 'faab' THEN 'faab_bid_won' ELSE 'waiver_claim_succeeded' END,
    CASE WHEN v_league.waiver_mode = 'faab' THEN 'FAAB bid won' ELSE 'Waiver claim succeeded' END,
    COALESCE(v_player_name, 'Player') || CASE
      WHEN v_league.waiver_mode = 'faab' THEN format(' won for $%s.', v_claim.bid_amount)
      ELSE ' added from waivers.'
    END,
    NULL,
    v_claim.member_id,
    v_claim.player_id,
    NULL,
    v_claim.id,
    jsonb_build_object('bid_amount', v_claim.bid_amount, 'waiver_mode', v_league.waiver_mode)
  );

  RETURN QUERY
    SELECT true, v_claim.id, v_claim.member_id, v_claim.player_id, 'succeeded'::waiver_claim_status, NULL::text;

  RETURN QUERY
  WITH failed AS (
    UPDATE waiver_claims AS wc_other
       SET status = 'failed_priority',
           processed_at = now(),
           failure_reason = CASE
             WHEN v_league.waiver_mode = 'faab' THEN 'Claimed by a higher FAAB bid or tiebreaker.'
             ELSE 'Claimed by higher-priority team.'
           END
     WHERE wc_other.status = 'pending'
       AND wc_other.league_id = v_claim.league_id
       AND wc_other.league_season_id = v_claim.league_season_id
       AND wc_other.player_id = v_claim.player_id
       AND wc_other.id <> v_claim.id
     RETURNING wc_other.id, wc_other.member_id, wc_other.player_id, wc_other.status, wc_other.failure_reason, wc_other.bid_amount
  ),
  logged AS (
    INSERT INTO league_activity (
      league_id,
      league_season_id,
      target_member_id,
      related_player_id,
      related_claim_id,
      event_type,
      title,
      body,
      metadata
    )
    SELECT
      v_claim.league_id,
      v_claim.league_season_id,
      failed.member_id,
      failed.player_id,
      failed.id,
      CASE WHEN v_league.waiver_mode = 'faab' THEN 'faab_bid_lost' ELSE 'waiver_claim_failed_priority' END,
      CASE WHEN v_league.waiver_mode = 'faab' THEN 'FAAB bid lost' ELSE 'Waiver claim failed' END,
      failed.failure_reason,
      jsonb_build_object('bid_amount', failed.bid_amount, 'winning_bid_amount', v_claim.bid_amount)
    FROM failed
    RETURNING id
  )
  SELECT true, failed.id, failed.member_id, failed.player_id, failed.status, failed.failure_reason
    FROM failed;
END;
$$;

CREATE OR REPLACE FUNCTION public.process_due_waiver_claims_atomic(
  p_process_date date,
  p_limit int DEFAULT 100
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
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 100), 0), 500);
  v_iteration int := 0;
  v_rows int;
BEGIN
  IF p_process_date IS NULL THEN
    RAISE EXCEPTION 'p_process_date is required.'
      USING ERRCODE = '22004';
  END IF;

  WHILE v_iteration < v_limit LOOP
    v_rows := 0;

    RETURN QUERY
    SELECT *
      FROM public.process_next_waiver_claim_atomic(p_process_date) AS processed_claim;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
      RETURN;
    END IF;

    v_iteration := v_iteration + v_rows;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.expire_waiver_wire_logs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expired integer;
BEGIN
  UPDATE waiver_wire_log AS wwl
     SET cleared_at = now()
    FROM league_seasons AS season,
         leagues AS league
   WHERE wwl.cleared_at IS NULL
     AND season.id = wwl.league_season_id
     AND season.is_current = true
     AND league.id = wwl.league_id
     AND league.status IN ('active'::league_status, 'playoffs'::league_status)
     AND wwl.clears_at < now()
     AND NOT EXISTS (
       SELECT 1
         FROM waiver_claims AS wc
        WHERE wc.league_id = wwl.league_id
          AND wc.league_season_id = wwl.league_season_id
          AND wc.player_id = wwl.player_id
          AND wc.status = 'pending'
     );

  GET DIAGNOSTICS v_expired = ROW_COUNT;
  RETURN v_expired;
END;
$$;

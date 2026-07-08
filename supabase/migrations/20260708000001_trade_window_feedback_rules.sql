-- Feedback F07: open trades in setup/drafting/offseason, lock only from the deadline until champion finalization.

CREATE OR REPLACE FUNCTION private.create_trade_offer(
  p_league_id uuid,
  p_league_season_id uuid,
  p_proposer_member_id uuid,
  p_recipient_member_id uuid,
  p_offer_player_ids uuid[],
  p_request_player_ids uuid[],
  p_offer_pick_ids uuid[],
  p_request_pick_ids uuid[],
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_offer_faab_amount int DEFAULT 0,
  p_request_faab_amount int DEFAULT 0,
  p_parent_trade_id uuid DEFAULT NULL,
  p_countered_from_trade_id uuid DEFAULT NULL,
  p_edited_from_trade_id uuid DEFAULT NULL,
  p_version int DEFAULT 1
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trade_id uuid;
  v_offer_player_ids uuid[] := COALESCE(p_offer_player_ids, ARRAY[]::uuid[]);
  v_request_player_ids uuid[] := COALESCE(p_request_player_ids, ARRAY[]::uuid[]);
  v_offer_pick_ids uuid[] := COALESCE(p_offer_pick_ids, ARRAY[]::uuid[]);
  v_request_pick_ids uuid[] := COALESCE(p_request_pick_ids, ARRAY[]::uuid[]);
  v_offer_faab_amount int := COALESCE(p_offer_faab_amount, 0);
  v_request_faab_amount int := COALESCE(p_request_faab_amount, 0);
  v_rows int;
  v_league leagues%ROWTYPE;
  v_balance int;
  v_champion_finalized boolean := false;
BEGIN
  IF p_proposer_member_id = p_recipient_member_id THEN
    RAISE EXCEPTION 'You cannot trade with yourself.';
  END IF;

  IF v_offer_faab_amount < 0 OR v_request_faab_amount < 0 THEN
    RAISE EXCEPTION 'FAAB trade amounts must be non-negative integers.'
      USING ERRCODE = '22023';
  END IF;

  IF cardinality(v_offer_player_ids) + cardinality(v_offer_pick_ids) + (CASE WHEN v_offer_faab_amount > 0 THEN 1 ELSE 0 END) = 0 OR
     cardinality(v_request_player_ids) + cardinality(v_request_pick_ids) + (CASE WHEN v_request_faab_amount > 0 THEN 1 ELSE 0 END) = 0 THEN
    RAISE EXCEPTION 'A trade must include at least one asset on each side.';
  END IF;

  IF (SELECT count(*) FROM unnest(v_offer_player_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_offer_player_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate offered players are not allowed.';
  END IF;
  IF (SELECT count(*) FROM unnest(v_request_player_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_request_player_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate requested players are not allowed.';
  END IF;
  IF (SELECT count(*) FROM unnest(v_offer_pick_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_offer_pick_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate offered picks are not allowed.';
  END IF;
  IF (SELECT count(*) FROM unnest(v_request_pick_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_request_pick_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate requested picks are not allowed.';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM matchups AS matchup
      JOIN league_seasons AS season
        ON season.id = matchup.league_season_id
       AND season.is_current = true
     WHERE matchup.league_id = p_league_id
       AND matchup.matchup_type = 'playoff_final'::matchup_type
       AND matchup.is_finalized = true
       AND matchup.winner_member_id IS NOT NULL
  )
    INTO v_champion_finalized;

  IF v_league.status = 'archived'::league_status THEN
    RAISE EXCEPTION 'Archived leagues are read-only.';
  END IF;

  IF v_league.status NOT IN (
    'setup'::league_status,
    'drafting'::league_status,
    'active'::league_status,
    'playoffs'::league_status,
    'offseason'::league_status
  ) THEN
    RAISE EXCEPTION 'Trades are not allowed for this league right now.';
  END IF;

  IF v_league.trade_deadline IS NOT NULL
     AND v_league.trade_deadline < (now() AT TIME ZONE 'America/New_York')::date THEN
    IF v_league.status = 'active'::league_status
       OR (v_league.status = 'playoffs'::league_status AND NOT v_champion_finalized) THEN
      RAISE EXCEPTION 'Trades are locked from the trade deadline until the champion is finalized.';
    END IF;
  END IF;

  IF p_expires_at IS NOT NULL THEN
    IF p_expires_at <= now() THEN
      RAISE EXCEPTION 'Trade expiration must be in the future.'
        USING ERRCODE = '22023';
    END IF;

    IF (v_league.status = 'active'::league_status
        OR (v_league.status = 'playoffs'::league_status AND NOT v_champion_finalized))
       AND v_league.trade_deadline IS NOT NULL
       AND (p_expires_at AT TIME ZONE 'America/New_York')::date > v_league.trade_deadline THEN
      RAISE EXCEPTION 'Trade expiration must be before the trade deadline.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF (v_offer_faab_amount > 0 OR v_request_faab_amount > 0) AND v_league.waiver_mode <> 'faab' THEN
    RAISE EXCEPTION 'FAAB can only be traded in FAAB waiver leagues.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons
   WHERE id = p_league_season_id
     AND league_id = p_league_id
     AND is_current = true
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season found.';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_proposer_member_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proposer not found.';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_recipient_member_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recipient not found.';
  END IF;

  WITH locked AS (
    SELECT player_id
      FROM roster_players
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND member_id = p_proposer_member_id
       AND player_id = ANY(v_offer_player_ids)
       AND is_on_ir = false
       AND is_on_taxi = false
     FOR SHARE
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> cardinality(v_offer_player_ids) THEN
    RAISE EXCEPTION 'Your offer includes a player that is no longer owned by the expected active roster side.';
  END IF;

  WITH locked AS (
    SELECT player_id
      FROM roster_players
     WHERE league_id = p_league_id
       AND league_season_id = p_league_season_id
       AND member_id = p_recipient_member_id
       AND player_id = ANY(v_request_player_ids)
       AND is_on_ir = false
       AND is_on_taxi = false
     FOR SHARE
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> cardinality(v_request_player_ids) THEN
    RAISE EXCEPTION 'Your request includes a player that is no longer owned by the expected active roster side.';
  END IF;

  WITH locked AS (
    SELECT id
      FROM draft_picks
     WHERE league_id = p_league_id
       AND current_owner_id = p_proposer_member_id
       AND is_used = false
       AND id = ANY(v_offer_pick_ids)
     FOR SHARE
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> cardinality(v_offer_pick_ids) THEN
    RAISE EXCEPTION 'Your offer includes a draft pick that is no longer owned by the expected team.';
  END IF;

  WITH locked AS (
    SELECT id
      FROM draft_picks
     WHERE league_id = p_league_id
       AND current_owner_id = p_recipient_member_id
       AND is_used = false
       AND id = ANY(v_request_pick_ids)
     FOR SHARE
  )
  SELECT count(*) INTO v_rows FROM locked;
  IF v_rows <> cardinality(v_request_pick_ids) THEN
    RAISE EXCEPTION 'Your request includes a draft pick that is no longer owned by the expected team.';
  END IF;

  IF v_offer_faab_amount > 0 THEN
    v_balance := private.ensure_faab_balance(p_league_id, p_league_season_id, p_proposer_member_id);
    IF v_balance < v_offer_faab_amount THEN
      RAISE EXCEPTION 'Offered FAAB exceeds the proposer''s available balance.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF v_request_faab_amount > 0 THEN
    v_balance := private.ensure_faab_balance(p_league_id, p_league_season_id, p_recipient_member_id);
    IF v_balance < v_request_faab_amount THEN
      RAISE EXCEPTION 'Requested FAAB exceeds the recipient''s available balance.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO trades (
    league_id,
    league_season_id,
    proposer_member_id,
    recipient_member_id,
    notes,
    status,
    expires_at,
    parent_trade_id,
    countered_from_trade_id,
    edited_from_trade_id,
    version,
    proposer_faab_amount,
    recipient_faab_amount
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_proposer_member_id,
    p_recipient_member_id,
    NULLIF(BTRIM(COALESCE(p_notes, '')), ''),
    'pending',
    p_expires_at,
    p_parent_trade_id,
    p_countered_from_trade_id,
    p_edited_from_trade_id,
    GREATEST(COALESCE(p_version, 1), 1),
    v_offer_faab_amount,
    v_request_faab_amount
  )
  RETURNING id INTO v_trade_id;

  INSERT INTO trade_items (trade_id, side, player_id, pick_id)
  SELECT v_trade_id, 'proposer'::trade_side, player_id, NULL::uuid
    FROM unnest(v_offer_player_ids) AS player_id
  UNION ALL
  SELECT v_trade_id, 'recipient'::trade_side, player_id, NULL::uuid
    FROM unnest(v_request_player_ids) AS player_id
  UNION ALL
  SELECT v_trade_id, 'proposer'::trade_side, NULL::uuid, pick_id
    FROM unnest(v_offer_pick_ids) AS pick_id
  UNION ALL
  SELECT v_trade_id, 'recipient'::trade_side, NULL::uuid, pick_id
    FROM unnest(v_request_pick_ids) AS pick_id;

  PERFORM private.log_league_activity(
    p_league_id,
    p_league_season_id,
    CASE
      WHEN p_countered_from_trade_id IS NOT NULL THEN 'trade_countered'
      WHEN p_edited_from_trade_id IS NOT NULL THEN 'trade_edited'
      ELSE 'trade_offered'
    END,
    CASE
      WHEN p_countered_from_trade_id IS NOT NULL THEN 'Counteroffer sent'
      WHEN p_edited_from_trade_id IS NOT NULL THEN 'Trade offer edited'
      ELSE 'Trade offer sent'
    END,
    NULL,
    p_proposer_member_id,
    p_recipient_member_id,
    NULL,
    v_trade_id,
    NULL,
    jsonb_build_object(
      'parent_trade_id', p_parent_trade_id,
      'countered_from_trade_id', p_countered_from_trade_id,
      'edited_from_trade_id', p_edited_from_trade_id,
      'version', GREATEST(COALESCE(p_version, 1), 1),
      'proposer_faab_amount', v_offer_faab_amount,
      'recipient_faab_amount', v_request_faab_amount
    )
  );

  RETURN v_trade_id;
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
  v_clear_player_id uuid;
  v_rows int;
  v_active_count int;
  v_balance int;
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
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_member_lock::text));
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
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_lock_player_id::text));
  END LOOP;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_trade.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  IF v_league.status = 'archived'::league_status THEN
    RAISE EXCEPTION 'Archived leagues are read-only.'
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

  IF v_trade.proposer_faab_amount > 0 THEN
    v_balance := private.ensure_faab_balance(v_trade.league_id, v_trade.league_season_id, v_trade.proposer_member_id);
    IF v_balance < v_trade.proposer_faab_amount THEN
      RAISE EXCEPTION 'Proposer no longer has enough FAAB for this trade.'
        USING ERRCODE = 'PT001';
    END IF;
  END IF;

  IF v_trade.recipient_faab_amount > 0 THEN
    v_balance := private.ensure_faab_balance(v_trade.league_id, v_trade.league_season_id, v_trade.recipient_member_id);
    IF v_balance < v_trade.recipient_faab_amount THEN
      RAISE EXCEPTION 'Recipient no longer has enough FAAB for this trade.'
        USING ERRCODE = 'PT001';
    END IF;
  END IF;

  FOR v_drop IN
    SELECT *
      FROM trade_drop_reservations
     WHERE trade_id = p_trade_id
     ORDER BY player_id ASC
     FOR UPDATE
  LOOP
    DELETE FROM trade_drop_reservations
     WHERE id = v_drop.id;

    PERFORM private.release_roster_player_to_waivers(
      v_drop.roster_player_id,
      v_trade.league_id,
      v_trade.league_season_id,
      v_drop.member_id,
      v_drop.player_id,
      'fa_drop',
      NULL,
      NULL,
      'Reserved drop player is no longer on the expected roster.'
    );
  END LOOP;

  FOR v_clear_player_id IN
    SELECT DISTINCT player_id
      FROM trade_items
     WHERE trade_id = p_trade_id
       AND player_id IS NOT NULL
     ORDER BY player_id
  LOOP
    PERFORM private.clear_future_unlocked_lineups(
      v_trade.league_id,
      v_trade.league_season_id,
      v_clear_player_id
    );
  END LOOP;

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

      PERFORM private.clear_trade_block_listing_for_asset(
        v_trade.league_id,
        v_from_member,
        v_item.player_id
      );

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

      PERFORM private.clear_trade_block_listing_for_asset(
        v_trade.league_id,
        v_from_member,
        NULL,
        v_item.pick_id
      );
    END IF;
  END LOOP;

  IF v_trade.proposer_faab_amount > 0 THEN
    UPDATE faab_balances
       SET balance = balance - v_trade.proposer_faab_amount,
           updated_at = now()
     WHERE league_id = v_trade.league_id
       AND league_season_id = v_trade.league_season_id
       AND member_id = v_trade.proposer_member_id;

    INSERT INTO faab_balances (
      league_id,
      league_season_id,
      member_id,
      balance
    )
    VALUES (
      v_trade.league_id,
      v_trade.league_season_id,
      v_trade.recipient_member_id,
      v_trade.proposer_faab_amount
    )
    ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE
       SET balance = faab_balances.balance + EXCLUDED.balance,
           updated_at = now();
  END IF;

  IF v_trade.recipient_faab_amount > 0 THEN
    UPDATE faab_balances
       SET balance = balance - v_trade.recipient_faab_amount,
           updated_at = now()
     WHERE league_id = v_trade.league_id
       AND league_season_id = v_trade.league_season_id
       AND member_id = v_trade.recipient_member_id;

    INSERT INTO faab_balances (
      league_id,
      league_season_id,
      member_id,
      balance
    )
    VALUES (
      v_trade.league_id,
      v_trade.league_season_id,
      v_trade.proposer_member_id,
      v_trade.recipient_faab_amount
    )
    ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE
       SET balance = faab_balances.balance + EXCLUDED.balance,
           updated_at = now();
  END IF;

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

  PERFORM private.log_league_activity(
    v_trade.league_id,
    v_trade.league_season_id,
    'trade_completed',
    'Trade completed',
    NULL,
    v_trade.proposer_member_id,
    v_trade.recipient_member_id,
    NULL,
    p_trade_id,
    NULL,
    jsonb_build_object(
      'proposer_faab_amount', v_trade.proposer_faab_amount,
      'recipient_faab_amount', v_trade.recipient_faab_amount
    )
  );
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
      AND league.status <> 'archived'::public.league_status
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

CREATE OR REPLACE FUNCTION public.prevent_trade_acceptance_after_deadline()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade_deadline date;
  v_league_status league_status;
  v_champion_finalized boolean := false;
BEGIN
  SELECT league.trade_deadline, league.status
    INTO v_trade_deadline, v_league_status
    FROM leagues AS league
   WHERE league.id = NEW.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM matchups AS matchup
     WHERE matchup.league_id = NEW.league_id
       AND matchup.league_season_id = NEW.league_season_id
       AND matchup.matchup_type = 'playoff_final'::matchup_type
       AND matchup.is_finalized = true
       AND matchup.winner_member_id IS NOT NULL
  )
    INTO v_champion_finalized;

  IF v_trade_deadline IS NOT NULL
     AND v_trade_deadline < (now() AT TIME ZONE 'America/New_York')::date THEN
    IF v_league_status = 'active'::league_status
       OR (v_league_status = 'playoffs'::league_status AND NOT v_champion_finalized) THEN
      RAISE EXCEPTION 'Trades are locked from the trade deadline until the champion is finalized.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_trade_acceptance_after_deadline ON public.trades;

CREATE TRIGGER prevent_trade_acceptance_after_deadline
  BEFORE UPDATE OF status ON public.trades
  FOR EACH ROW
  WHEN (OLD.status = 'pending'::trade_status AND NEW.status = 'accepted'::trade_status)
  EXECUTE FUNCTION public.prevent_trade_acceptance_after_deadline();

CREATE OR REPLACE FUNCTION public.accept_trade_atomic(
  p_trade_id uuid,
  p_accepting_member_id uuid,
  p_drop_roster_player_ids uuid[] DEFAULT ARRAY[]::uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_item trade_items%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_drop_ids uuid[] := COALESCE(p_drop_roster_player_ids, ARRAY[]::uuid[]);
  v_from_member uuid;
  v_member_lock uuid;
  v_lock_player_id uuid;
  v_rows int;
  v_active_count int;
  v_incoming_players int;
  v_outgoing_players int;
  v_required_drops int;
  v_proposer_active_count int;
  v_proposer_incoming_players int;
  v_proposer_outgoing_players int;
  v_proposer_required_drops int;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found';
  END IF;

  IF v_trade.status <> 'pending' THEN
    RAISE EXCEPTION 'This trade is no longer pending';
  END IF;

  IF v_trade.recipient_member_id <> p_accepting_member_id THEN
    RAISE EXCEPTION 'Only the recipient can accept this trade';
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

  IF (SELECT count(*) FROM unnest(v_drop_ids) AS id) <>
     (SELECT count(DISTINCT id) FROM unnest(v_drop_ids) AS id) THEN
    RAISE EXCEPTION 'Duplicate drop players are not allowed.';
  END IF;

  FOR v_lock_player_id IN
    SELECT DISTINCT player_id
      FROM (
        SELECT player_id
          FROM trade_items
         WHERE trade_id = p_trade_id
           AND player_id IS NOT NULL
        UNION ALL
        SELECT player_id
          FROM roster_players
         WHERE id = ANY(v_drop_ids)
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

  IF v_league.status = 'archived'::league_status THEN
    RAISE EXCEPTION 'Archived leagues are read-only.'
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
        RAISE EXCEPTION 'Player asset is no longer owned by the expected active roster side';
      END IF;

      IF EXISTS (
        SELECT 1
          FROM trade_items AS accepted_item
          JOIN trades AS accepted_trade
            ON accepted_trade.id = accepted_item.trade_id
           AND accepted_trade.status = 'accepted'::trade_status
         WHERE accepted_item.player_id = v_item.player_id
           AND accepted_trade.id <> p_trade_id
           AND accepted_trade.league_id = v_trade.league_id
           AND accepted_trade.league_season_id = v_trade.league_season_id
           AND (
             (accepted_item.side = 'proposer' AND accepted_trade.proposer_member_id = v_from_member)
             OR (accepted_item.side = 'recipient' AND accepted_trade.recipient_member_id = v_from_member)
           )
      ) THEN
        RAISE EXCEPTION 'Player asset is reserved for another accepted trade';
      END IF;

      IF EXISTS (
        SELECT 1
          FROM trade_drop_reservations AS reservation
          JOIN trades AS accepted_trade
            ON accepted_trade.id = reservation.trade_id
           AND accepted_trade.status = 'accepted'::trade_status
         WHERE reservation.player_id = v_item.player_id
           AND reservation.member_id = v_from_member
           AND accepted_trade.id <> p_trade_id
           AND accepted_trade.league_id = v_trade.league_id
           AND accepted_trade.league_season_id = v_trade.league_season_id
      ) THEN
        RAISE EXCEPTION 'Player asset is reserved as a drop for another accepted trade';
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
        RAISE EXCEPTION 'Draft-pick asset is no longer owned by the expected trade side';
      END IF;

      IF EXISTS (
        SELECT 1
          FROM trade_items AS accepted_item
          JOIN trades AS accepted_trade
            ON accepted_trade.id = accepted_item.trade_id
           AND accepted_trade.status = 'accepted'::trade_status
         WHERE accepted_item.pick_id = v_item.pick_id
           AND accepted_trade.id <> p_trade_id
           AND accepted_trade.league_id = v_trade.league_id
           AND accepted_trade.league_season_id = v_trade.league_season_id
      ) THEN
        RAISE EXCEPTION 'Draft-pick asset is reserved for another accepted trade';
      END IF;
    END IF;
  END LOOP;

  IF cardinality(v_drop_ids) > 0 THEN
    WITH locked AS (
      SELECT *
        FROM roster_players
       WHERE id = ANY(v_drop_ids)
         AND league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = p_accepting_member_id
         AND is_on_ir = false
         AND is_on_taxi = false
       FOR UPDATE
    )
    SELECT count(*) INTO v_rows FROM locked;

    IF v_rows <> cardinality(v_drop_ids) THEN
      RAISE EXCEPTION 'Drop list includes a player that is no longer on your active roster.';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM roster_players AS rp
        JOIN trade_items AS ti
          ON ti.trade_id = p_trade_id
         AND ti.player_id = rp.player_id
       WHERE rp.id = ANY(v_drop_ids)
    ) THEN
      RAISE EXCEPTION 'You cannot drop a player included in this trade.';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM trade_drop_reservations AS reservation
        JOIN trades AS trade
          ON trade.id = reservation.trade_id
         AND trade.status = 'accepted'::trade_status
       WHERE reservation.roster_player_id = ANY(v_drop_ids)
         AND reservation.trade_id <> p_trade_id
    ) THEN
      RAISE EXCEPTION 'A selected drop player is already reserved for another accepted trade.';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM roster_players AS rp
        JOIN trade_items AS accepted_item
          ON accepted_item.player_id = rp.player_id
        JOIN trades AS accepted_trade
          ON accepted_trade.id = accepted_item.trade_id
         AND accepted_trade.status = 'accepted'::trade_status
       WHERE rp.id = ANY(v_drop_ids)
         AND accepted_trade.id <> p_trade_id
         AND accepted_trade.league_id = v_trade.league_id
         AND accepted_trade.league_season_id = v_trade.league_season_id
         AND (
           (accepted_item.side = 'proposer' AND accepted_trade.proposer_member_id = rp.member_id)
           OR (accepted_item.side = 'recipient' AND accepted_trade.recipient_member_id = rp.member_id)
         )
    ) THEN
      RAISE EXCEPTION 'A selected drop player is reserved as an asset for another accepted trade.';
    END IF;
  END IF;

  SELECT count(*)
    INTO v_active_count
    FROM roster_players
   WHERE league_id = v_trade.league_id
     AND league_season_id = v_trade.league_season_id
     AND member_id = p_accepting_member_id
     AND is_on_ir = false
     AND is_on_taxi = false;

  SELECT count(*)
    INTO v_incoming_players
    FROM trade_items
   WHERE trade_id = p_trade_id
     AND side = 'proposer'
     AND player_id IS NOT NULL;

  SELECT count(*)
    INTO v_outgoing_players
    FROM trade_items
   WHERE trade_id = p_trade_id
     AND side = 'recipient'
     AND player_id IS NOT NULL;

  v_required_drops := GREATEST(v_active_count - v_outgoing_players + v_incoming_players - COALESCE(v_league.roster_size, 0), 0);
  IF cardinality(v_drop_ids) <> v_required_drops THEN
    RAISE EXCEPTION 'Accepting this trade requires exactly % active roster drop(s).', v_required_drops;
  END IF;

  SELECT count(*)
    INTO v_proposer_active_count
    FROM roster_players
   WHERE league_id = v_trade.league_id
     AND league_season_id = v_trade.league_season_id
     AND member_id = v_trade.proposer_member_id
     AND is_on_ir = false
     AND is_on_taxi = false;

  SELECT count(*)
    INTO v_proposer_incoming_players
    FROM trade_items
   WHERE trade_id = p_trade_id
     AND side = 'recipient'
     AND player_id IS NOT NULL;

  SELECT count(*)
    INTO v_proposer_outgoing_players
    FROM trade_items
   WHERE trade_id = p_trade_id
     AND side = 'proposer'
     AND player_id IS NOT NULL;

  v_proposer_required_drops := GREATEST(
    v_proposer_active_count - v_proposer_outgoing_players + v_proposer_incoming_players - COALESCE(v_league.roster_size, 0),
    0
  );

  IF v_proposer_required_drops > 0 THEN
    RAISE EXCEPTION 'This trade would overfill the proposer roster.';
  END IF;

  DELETE FROM trade_drop_reservations WHERE trade_id = p_trade_id;

  INSERT INTO trade_drop_reservations (
    trade_id,
    roster_player_id,
    member_id,
    player_id
  )
  SELECT
    p_trade_id,
    rp.id,
    rp.member_id,
    rp.player_id
  FROM roster_players AS rp
  WHERE rp.id = ANY(v_drop_ids)
  ORDER BY rp.player_id ASC;

  UPDATE trades
     SET status = 'accepted',
         accepted_at = now(),
         veto_window_expires_at = now() + INTERVAL '24 hours',
         completed_at = NULL,
         vetoed_at = NULL
   WHERE id = p_trade_id
     AND status = 'pending';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to accept trade atomically';
  END IF;
END;
$$;

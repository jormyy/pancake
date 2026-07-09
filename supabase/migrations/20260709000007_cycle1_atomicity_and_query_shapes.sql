CREATE OR REPLACE FUNCTION public.accept_multi_team_trade_atomic(
  p_trade_id uuid,
  p_accepting_member_id uuid,
  p_drop_roster_player_ids uuid[] DEFAULT ARRAY[]::uuid[]
)
RETURNS jsonb
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
  v_to_member uuid;
  v_member_lock uuid;
  v_lock_player_id uuid;
  v_rows int;
  v_active_count int;
  v_incoming_players int;
  v_outgoing_players int;
  v_required_drops int;
  v_all_accepted boolean;
  v_veto_window_hours int;
  v_item_faab_amount int;
  v_balance int;
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

  IF COALESCE(v_trade.is_multi_team, false) = false THEN
    RAISE EXCEPTION 'This trade is not a multi-team offer.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.expires_at IS NOT NULL AND v_trade.expires_at <= now() THEN
    UPDATE trades SET status = 'expired'::trade_status WHERE id = p_trade_id;
    RAISE EXCEPTION 'This trade offer has expired.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM trade_participants
   WHERE trade_id = p_trade_id
     AND member_id = p_accepting_member_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only a trade participant can accept this trade.'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_participants
     WHERE trade_id = p_trade_id
       AND member_id = p_accepting_member_id
       AND accepted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'This participant has already accepted the trade.'
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_member_lock IN
    SELECT participant.member_id
      FROM trade_participants AS participant
     WHERE participant.trade_id = p_trade_id
     ORDER BY participant.member_id ASC
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

  FOR v_from_member, v_item_faab_amount IN
    SELECT
      COALESCE(item.from_member_id, CASE
        WHEN item.side = 'proposer' THEN v_trade.proposer_member_id
        ELSE v_trade.recipient_member_id
      END),
      sum(item.faab_amount)::int
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.faab_amount > 0
     GROUP BY 1
  LOOP
    v_balance := private.ensure_faab_balance(v_trade.league_id, v_trade.league_season_id, v_from_member);
    IF v_balance < v_item_faab_amount THEN
      RAISE EXCEPTION 'Trade participant no longer has enough FAAB for this trade.';
    END IF;
  END LOOP;

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := COALESCE(v_item.from_member_id, CASE
      WHEN v_item.side = 'proposer' THEN v_trade.proposer_member_id
      ELSE v_trade.recipient_member_id
    END);

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
           AND COALESCE(
             accepted_item.from_member_id,
             CASE WHEN accepted_item.side = 'proposer' THEN accepted_trade.proposer_member_id ELSE accepted_trade.recipient_member_id END
           ) = v_from_member
      ) THEN
        RAISE EXCEPTION 'Player asset is reserved for another accepted trade';
      END IF;
    ELSIF v_item.pick_id IS NOT NULL THEN
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
    ELSE
      v_item_faab_amount := COALESCE(v_item.faab_amount, 0);
      IF v_item_faab_amount <= 0 THEN
        RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount';
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
     AND COALESCE(to_member_id, CASE WHEN side = 'proposer' THEN v_trade.recipient_member_id ELSE v_trade.proposer_member_id END) = p_accepting_member_id
     AND player_id IS NOT NULL;

  SELECT count(*)
    INTO v_outgoing_players
    FROM trade_items
   WHERE trade_id = p_trade_id
     AND COALESCE(from_member_id, CASE WHEN side = 'proposer' THEN v_trade.proposer_member_id ELSE v_trade.recipient_member_id END) = p_accepting_member_id
     AND player_id IS NOT NULL;

  v_required_drops := GREATEST(v_active_count - v_outgoing_players + v_incoming_players - COALESCE(v_league.roster_size, 0), 0);
  IF cardinality(v_drop_ids) <> v_required_drops THEN
    RAISE EXCEPTION 'Accepting this trade requires exactly % active roster drop(s).', v_required_drops;
  END IF;

  DELETE FROM trade_drop_reservations
   WHERE trade_id = p_trade_id
     AND member_id = p_accepting_member_id;

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

  UPDATE trade_participants
     SET accepted_at = now()
   WHERE trade_id = p_trade_id
     AND member_id = p_accepting_member_id
     AND accepted_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to record participant acceptance.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT NOT EXISTS (
    SELECT 1
      FROM trade_participants
     WHERE trade_id = p_trade_id
       AND accepted_at IS NULL
  )
    INTO v_all_accepted;

  IF v_all_accepted THEN
    v_veto_window_hours := CASE
      WHEN COALESCE(v_league.trade_veto_mode, 'member_vote') = 'disabled' THEN 0
      ELSE LEAST(GREATEST(COALESCE(v_league.trade_veto_window_hours, 24), 0), 168)
    END;

    UPDATE trades
       SET status = 'accepted',
           accepted_at = now(),
           veto_window_expires_at = now() + make_interval(hours => v_veto_window_hours),
           completed_at = NULL,
           vetoed_at = NULL
     WHERE id = p_trade_id
       AND status = 'pending';

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Failed to accept trade atomically';
    END IF;

    IF COALESCE(v_league.trade_veto_mode, 'member_vote') = 'disabled'
       OR v_veto_window_hours = 0 THEN
      PERFORM public.complete_accepted_trade_atomic(p_trade_id);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'allAccepted', v_all_accepted,
    'proposerMemberId', v_trade.proposer_member_id,
    'recipientMemberId', v_trade.recipient_member_id,
    'participantMemberIds', (
      SELECT jsonb_agg(participant.member_id ORDER BY participant.sort_order, participant.member_id)
        FROM trade_participants AS participant
       WHERE participant.trade_id = p_trade_id
    )
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
  v_clear_player_id uuid;
  v_rows int;
  v_active_count int;
  v_balance int;
  v_item_faab_amount int;
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
        UNION
        SELECT participant.member_id
          FROM trade_participants AS participant
         WHERE participant.trade_id = p_trade_id
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

  FOR v_from_member, v_item_faab_amount IN
    SELECT
      COALESCE(item.from_member_id, CASE
        WHEN item.side = 'proposer' THEN v_trade.proposer_member_id
        ELSE v_trade.recipient_member_id
      END),
      sum(item.faab_amount)::int
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.faab_amount > 0
     GROUP BY 1
  LOOP
    v_balance := private.ensure_faab_balance(v_trade.league_id, v_trade.league_season_id, v_from_member);
    IF v_balance < v_item_faab_amount THEN
      RAISE EXCEPTION 'Trade participant no longer has enough FAAB for this trade.'
        USING ERRCODE = 'PT001';
    END IF;
  END LOOP;

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := COALESCE(v_item.from_member_id, CASE
      WHEN v_item.side = 'proposer' THEN v_trade.proposer_member_id
      ELSE v_trade.recipient_member_id
    END);

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
    ELSIF v_item.pick_id IS NOT NULL THEN
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
    ELSE
      v_item_faab_amount := COALESCE(v_item.faab_amount, 0);
      IF v_item_faab_amount <= 0 THEN
        RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount'
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

  FOR v_from_member, v_item_faab_amount IN
    SELECT
      COALESCE(item.from_member_id, CASE
        WHEN item.side = 'proposer' THEN v_trade.proposer_member_id
        ELSE v_trade.recipient_member_id
      END),
      sum(item.faab_amount)::int
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.faab_amount > 0
     GROUP BY 1
  LOOP
    UPDATE faab_balances
       SET balance = balance - v_item_faab_amount,
           updated_at = now()
     WHERE league_id = v_trade.league_id
       AND league_season_id = v_trade.league_season_id
       AND member_id = v_from_member
       AND balance >= v_item_faab_amount;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Trade participant no longer has enough FAAB for this trade.'
        USING ERRCODE = 'PT001';
    END IF;
  END LOOP;

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := COALESCE(v_item.from_member_id, CASE
      WHEN v_item.side = 'proposer' THEN v_trade.proposer_member_id
      ELSE v_trade.recipient_member_id
    END);
    v_to_member := COALESCE(v_item.to_member_id, CASE
      WHEN v_item.side = 'proposer' THEN v_trade.recipient_member_id
      ELSE v_trade.proposer_member_id
    END);

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
    ELSIF v_item.pick_id IS NOT NULL THEN
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
    ELSE
      v_item_faab_amount := COALESCE(v_item.faab_amount, 0);
      IF v_item_faab_amount <= 0 THEN
        RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount'
          USING ERRCODE = 'PT001';
      END IF;

      INSERT INTO faab_balances (
        league_id,
        league_season_id,
        member_id,
        balance
      )
      VALUES (
        v_trade.league_id,
        v_trade.league_season_id,
        v_to_member,
        v_item_faab_amount
      )
      ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE
         SET balance = faab_balances.balance + EXCLUDED.balance,
             updated_at = now();
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
    UNION
    SELECT participant.member_id
      FROM trade_participants AS participant
     WHERE participant.trade_id = p_trade_id
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
      'recipient_faab_amount', v_trade.recipient_faab_amount,
      'is_multi_team', COALESCE(v_trade.is_multi_team, false)
    )
  );
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
       candidate.process_date,
       candidate.league_id,
       candidate.league_season_id,
       candidate.player_id
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

CREATE OR REPLACE FUNCTION public.update_league_configuration_atomic(
  p_league_id uuid,
  p_settings jsonb,
  p_slots jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_settings IS NULL OR jsonb_typeof(p_settings) <> 'object' THEN
    RAISE EXCEPTION 'p_settings must be a JSON object.'
      USING ERRCODE = '22023';
  END IF;

  IF p_settings <> '{}'::jsonb THEN
    PERFORM public.update_league_settings_atomic(p_league_id, p_settings);
  END IF;

  IF p_slots IS NOT NULL THEN
    PERFORM public.update_lineup_slots_atomic(p_league_id, p_slots);
  END IF;
END;
$$;

DROP INDEX IF EXISTS public.idx_waiver_claims_pending_due_processing;

CREATE INDEX idx_waiver_claims_pending_due_groups
  ON public.waiver_claims (process_date, league_id, league_season_id, player_id)
  INCLUDE (member_id, bid_amount, claim_order, submitted_at)
  WHERE status = 'pending'::public.waiver_claim_status;

CREATE INDEX idx_waiver_claims_pending_player_candidates
  ON public.waiver_claims (league_id, league_season_id, player_id, process_date)
  INCLUDE (member_id, bid_amount, claim_order, submitted_at)
  WHERE status = 'pending'::public.waiver_claim_status;

REVOKE ALL ON FUNCTION public.update_league_configuration_atomic(uuid, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_league_configuration_atomic(uuid, jsonb, jsonb) TO authenticated, service_role;

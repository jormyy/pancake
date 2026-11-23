CREATE OR REPLACE FUNCTION public.drop_player_atomic(p_roster_player_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rp roster_players%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_league_id uuid;
  v_player_id uuid;
  v_member_id uuid;
  v_clears_at timestamptz := now() + interval '48 hours';
  v_rows int;
BEGIN
  SELECT league_id, player_id, member_id
    INTO v_league_id, v_player_id, v_member_id
    FROM roster_players
   WHERE id = p_roster_player_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_league_id::text),
    hashtext(v_member_id::text)
  );

  PERFORM pg_advisory_xact_lock(
    hashtext(v_league_id::text),
    hashtext(v_player_id::text)
  );

  SELECT *
    INTO v_rp
    FROM roster_players
   WHERE id = p_roster_player_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_rp.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status, 'offseason'::league_status) THEN
    RAISE EXCEPTION 'Roster moves are only allowed during a draft or active/playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_rp.league_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster moves are only allowed for the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = v_rp.member_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  DELETE FROM roster_players
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO waiver_wire_log (
    league_id,
    league_season_id,
    player_id,
    dropped_by_member_id,
    clears_at
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.player_id,
    v_rp.member_id,
    v_clears_at
  );

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.member_id,
    v_rp.player_id,
    'fa_drop'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION private.accept_trade_participant_atomic(
  p_trade_id uuid,
  p_accepting_member_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_from_member uuid;
  v_member_lock uuid;
  v_lock_player_id uuid;
  v_rows int;
  v_all_accepted boolean;
  v_veto_window_hours int;
  v_item_faab_amount int;
  v_balance int;
BEGIN
  -- Read first, lock parties and players in the order every roster mutation
  -- uses, then lock the trade row: a drop that expires this offer holds the
  -- member and player locks while it updates the trade, so taking the trade
  -- row first would deadlock against it.
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.expires_at IS NOT NULL AND v_trade.expires_at <= now() THEN
    UPDATE trades SET status = 'expired'::trade_status WHERE id = p_trade_id;
    RETURN jsonb_build_object(
      'expired', true,
      'isMultiTeam', COALESCE(v_trade.is_multi_team, false),
      'allAccepted', false,
      'proposerMemberId', v_trade.proposer_member_id,
      'recipientMemberId', v_trade.recipient_member_id,
      'participantMemberIds', (
        SELECT jsonb_agg(participant.member_id ORDER BY participant.sort_order, participant.member_id)
          FROM trade_participants AS participant
         WHERE participant.trade_id = p_trade_id
      )
    );
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

  FOR v_lock_player_id IN
    SELECT DISTINCT player_id
      FROM trade_items
     WHERE trade_id = p_trade_id
       AND player_id IS NOT NULL
     ORDER BY player_id ASC
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext(v_trade.league_id::text),
      hashtext(v_lock_player_id::text)
    );
  END LOOP;

  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

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
      item.from_member_id,
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

  PERFORM private.assert_trade_assets_acceptance_ready(
    p_trade_id,
    v_trade.league_id,
    v_trade.league_season_id
  );

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.player_id IS NULL
       AND item.pick_id IS NULL
       AND COALESCE(item.faab_amount, 0) <= 0
  ) THEN
    RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount';
  END IF;

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
           veto_window_expires_at = CASE
             WHEN v_veto_window_hours = 0 THEN now() - interval '1 microsecond'
             ELSE now() + make_interval(hours => v_veto_window_hours)
           END,
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
    'expired', false,
    'isMultiTeam', COALESCE(v_trade.is_multi_team, false),
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

CREATE OR REPLACE FUNCTION private.sync_roster_linked_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_left_roster boolean := TG_OP = 'DELETE' OR OLD.member_id IS DISTINCT FROM NEW.member_id;
  v_became_inactive boolean := TG_OP = 'UPDATE'
    AND (NEW.is_on_ir = true OR NEW.is_on_taxi = true)
    AND (OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi);
BEGIN
  IF NOT (v_left_roster OR v_became_inactive) THEN
    RETURN NULL;
  END IF;

  -- An old-season row going away never touches live state.
  IF NOT EXISTS (SELECT 1 FROM league_seasons WHERE id = OLD.league_season_id AND is_current = true) THEN
    RETURN NULL;
  END IF;


  PERFORM private.clear_future_unlocked_lineups(
    OLD.league_id,
    OLD.league_season_id,
    OLD.player_id,
    OLD.member_id
  );

  DELETE FROM trade_block_items
   WHERE league_id = OLD.league_id
     AND member_id = OLD.member_id
     AND player_id = OLD.player_id;

  IF v_left_roster THEN
    UPDATE waiver_claims
       SET drop_player_id = NULL
     WHERE status = 'pending'::waiver_claim_status
       AND league_id = OLD.league_id
       AND league_season_id = OLD.league_season_id
       AND member_id = OLD.member_id
       AND drop_player_id = OLD.player_id;

    PERFORM private.expire_pending_trades_for_lost_asset(
      OLD.league_id,
      OLD.member_id,
      OLD.player_id
    );
  END IF;

  RETURN NULL;
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
  v_league leagues%ROWTYPE;
  v_from_member uuid;
  v_to_member uuid;
  v_member_lock uuid;
  v_lock_player_id uuid;
  v_rows int;
  v_balance int;
  v_item_faab_amount int;
  v_previous_flag text;
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
      FROM trade_items
     WHERE trade_id = p_trade_id
       AND player_id IS NOT NULL
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
      item.from_member_id,
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
    v_from_member := v_item.from_member_id;

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

  FOR v_from_member, v_item_faab_amount IN
    SELECT
      item.from_member_id,
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

  -- A reserved pick may only change hands through this completion; the
  -- draft_picks guard and the trade status guard honour this mark.
  v_previous_flag := private.begin_trade_lifecycle_write();

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := v_item.from_member_id;
    v_to_member := v_item.to_member_id;

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

  PERFORM private.end_trade_lifecycle_write(v_previous_flag);

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

CREATE OR REPLACE FUNCTION private.ensure_faab_balance(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid
)
RETURNS int
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_balance int;
  v_starting_budget int;
BEGIN
  SELECT balance
    INTO v_balance
    FROM faab_balances
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = p_member_id
   FOR UPDATE;

  IF FOUND THEN
    RETURN v_balance;
  END IF;

  SELECT faab_starting_budget
    INTO v_starting_budget
    FROM leagues
   WHERE id = p_league_id;

  INSERT INTO faab_balances (
    league_id,
    league_season_id,
    member_id,
    balance
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_member_id,
    COALESCE(v_starting_budget, 100)
  )
  ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE
     SET updated_at = now()
  RETURNING balance INTO v_balance;

  RETURN v_balance;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_trade_assets_acceptance_ready(
  p_trade_id uuid,
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM 1
    FROM trade_items AS item
    JOIN roster_players AS roster
      ON roster.league_id = p_league_id
     AND roster.league_season_id = p_league_season_id
     AND roster.member_id = item.from_member_id
     AND roster.player_id = item.player_id
   WHERE item.trade_id = p_trade_id
     AND item.player_id IS NOT NULL
   ORDER BY roster.id
   FOR UPDATE OF roster;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.player_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM roster_players AS roster
          WHERE roster.league_id = p_league_id
            AND roster.league_season_id = p_league_season_id
            AND roster.member_id = item.from_member_id
            AND roster.player_id = item.player_id
            AND roster.is_on_ir = false
            AND roster.is_on_taxi = false
       )
  ) THEN
    RAISE EXCEPTION 'Player asset is no longer owned by the expected active roster side';
  END IF;

  PERFORM private.assert_not_reserved_trade_asset(p_league_id, p_league_season_id, item.from_member_id, item.player_id, NULL, p_trade_id)
     FROM trade_items AS item
    WHERE item.trade_id = p_trade_id
      AND item.player_id IS NOT NULL;

  PERFORM 1
    FROM trade_items AS item
    JOIN draft_picks AS pick
      ON pick.id = item.pick_id
     AND pick.league_id = p_league_id
     AND pick.current_owner_id = item.from_member_id
     AND pick.is_used = false
   WHERE item.trade_id = p_trade_id
     AND item.pick_id IS NOT NULL
   ORDER BY pick.id
   FOR UPDATE OF pick;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.pick_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM draft_picks AS pick
          WHERE pick.id = item.pick_id
            AND pick.league_id = p_league_id
            AND pick.current_owner_id = item.from_member_id
            AND pick.is_used = false
       )
  ) THEN
    RAISE EXCEPTION 'Draft-pick asset is no longer owned by the expected trade side';
  END IF;

  PERFORM private.assert_not_reserved_trade_asset(p_league_id, p_league_season_id, item.from_member_id, NULL, item.pick_id, p_trade_id)
     FROM trade_items AS item
    WHERE item.trade_id = p_trade_id
      AND item.pick_id IS NOT NULL;
END;
$$;

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
     AND NOT private.lineup_game_started(wl.player_id, wl.game_date);
$$;

CREATE OR REPLACE FUNCTION private.expire_pending_trades_for_lost_asset(
  p_league_id uuid,
  p_member_id uuid,
  p_player_id uuid DEFAULT NULL,
  p_pick_id uuid DEFAULT NULL,
  p_pick_consumed boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reason text;
  v_previous_flag text;
BEGIN
  IF p_player_id IS NOT NULL THEN
    SELECT format('%s is no longer on %s.', player.display_name, COALESCE(member.team_name, 'the offering team'))
      INTO v_reason
      FROM players AS player, league_members AS member
     WHERE player.id = p_player_id
       AND member.id = p_member_id;
  ELSE
    SELECT format(
             CASE
               WHEN p_pick_consumed THEN 'The %s round %s pick has been used in the draft.'
               ELSE 'The %s round %s pick is no longer owned by %s.'
             END,
             pick.season_year,
             pick.round,
             COALESCE(member.team_name, 'the offering team')
           )
      INTO v_reason
      FROM draft_picks AS pick, league_members AS member
     WHERE pick.id = p_pick_id
       AND member.id = p_member_id;
  END IF;

  -- This may run inside an authenticated user's transaction (a drop expiring
  -- an offer); the status guard trusts server-owned lifecycle work.
  v_previous_flag := private.begin_trade_lifecycle_write();

  WITH expired AS (
    UPDATE trades AS trade
       SET status = 'expired'::trade_status,
           completion_failure_reason = v_reason
     WHERE trade.league_id = p_league_id
       AND trade.status = 'pending'::trade_status
       AND EXISTS (
         SELECT 1
           FROM trade_items AS item
          WHERE item.trade_id = trade.id
            AND item.from_member_id = p_member_id
            AND (
              (p_player_id IS NOT NULL AND item.player_id = p_player_id)
              OR (p_pick_id IS NOT NULL AND item.pick_id = p_pick_id)
            )
       )
     RETURNING trade.id, trade.league_id, trade.league_season_id, trade.proposer_member_id, trade.recipient_member_id
  )
  -- The reason stays on the trade (visible to its parties); the league-wide
  -- activity row names no asset of a pending offer.
  INSERT INTO league_activity (
    league_id,
    league_season_id,
    actor_member_id,
    target_member_id,
    related_trade_id,
    event_type,
    title
  )
  SELECT
    expired.league_id,
    expired.league_season_id,
    expired.proposer_member_id,
    expired.recipient_member_id,
    expired.id,
    'trade_expired',
    'Trade offer expired'
    FROM expired;

  PERFORM private.end_trade_lifecycle_write(v_previous_flag);
END;
$$;

CREATE OR REPLACE FUNCTION private.log_league_activity(
  p_league_id uuid,
  p_league_season_id uuid,
  p_event_type text,
  p_title text,
  p_body text DEFAULT NULL,
  p_actor_member_id uuid DEFAULT NULL,
  p_target_member_id uuid DEFAULT NULL,
  p_related_player_id uuid DEFAULT NULL,
  p_related_trade_id uuid DEFAULT NULL,
  p_related_claim_id uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO league_activity (
    league_id,
    league_season_id,
    actor_member_id,
    target_member_id,
    related_player_id,
    related_trade_id,
    related_claim_id,
    event_type,
    title,
    body,
    metadata
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_actor_member_id,
    p_target_member_id,
    p_related_player_id,
    p_related_trade_id,
    p_related_claim_id,
    p_event_type,
    p_title,
    p_body,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.begin_trade_lifecycle_write()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_previous text := COALESCE(current_setting('app.trade_lifecycle_server_write', true), '');
BEGIN
  -- Marks the transaction as server-owned trade lifecycle work so the status
  -- and reservation guards let it through; returns the value to restore.
  PERFORM set_config('app.trade_lifecycle_server_write', 'on', true);
  RETURN v_previous;
END;
$$;

CREATE OR REPLACE FUNCTION private.end_trade_lifecycle_write(
  p_previous text
)
RETURNS void
LANGUAGE sql
AS $$
  SELECT set_config('app.trade_lifecycle_server_write', COALESCE(p_previous, ''), true)
$$;

CREATE OR REPLACE FUNCTION private.assert_not_reserved_trade_asset(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_player_id uuid DEFAULT NULL,
  p_pick_id uuid DEFAULT NULL,
  p_exclude_trade_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF private.is_reserved_trade_asset(p_league_id, p_league_season_id, p_member_id, p_player_id, p_pick_id, p_exclude_trade_id) THEN
    RAISE EXCEPTION '%', private.reserved_trade_asset_message() USING ERRCODE = 'PA004';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.lineup_game_started(p_player_id uuid, p_game_date date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- A lineup slot locks once the player's game that day has started: the feed
  -- says so, its scheduled tip-off has passed, or a start time is recorded.
  SELECT EXISTS (
    SELECT 1
      FROM players AS p
      JOIN nba_games AS g
        ON g.game_date = p_game_date
       AND (g.home_team = p.nba_team OR g.away_team = p.nba_team)
     WHERE p.id = p_player_id
       AND (
         g.status IN ('InProgress', 'Final')
         OR (g.game_time IS NOT NULL AND g.game_time <= now())
         OR (g.started_at IS NOT NULL AND g.started_at <= now())
       )
  )
$$;

CREATE OR REPLACE FUNCTION private.is_reserved_trade_asset(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid,
  p_player_id uuid DEFAULT NULL,
  p_pick_id uuid DEFAULT NULL,
  p_exclude_trade_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM trade_items AS item
      JOIN trades AS trade
        ON trade.id = item.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE trade.league_id = p_league_id
       AND (p_league_season_id IS NULL OR trade.league_season_id = p_league_season_id)
       AND (p_exclude_trade_id IS NULL OR trade.id <> p_exclude_trade_id)
       AND item.from_member_id = p_member_id
       AND (
         (p_player_id IS NOT NULL AND item.player_id = p_player_id)
         OR (p_pick_id IS NOT NULL AND item.pick_id = p_pick_id)
       )
  )
$$;

CREATE OR REPLACE FUNCTION private.reserved_trade_asset_message()
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 'This asset is reserved by an accepted trade.'
$$;

CREATE TRIGGER sync_roster_linked_state
AFTER DELETE OR UPDATE OF member_id, is_on_ir, is_on_taxi ON public.roster_players
FOR EACH ROW
EXECUTE FUNCTION private.sync_roster_linked_state();

CREATE OR REPLACE FUNCTION private.sync_roster_linked_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_left_roster boolean := TG_OP = 'DELETE' OR OLD.member_id IS DISTINCT FROM NEW.member_id;
  v_cancel_claims boolean;
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
    v_cancel_claims := private.trade_lifecycle_write_active()
      AND EXISTS (SELECT 1 FROM leagues WHERE id=OLD.league_id AND allow_inactive_trades);
    IF v_cancel_claims THEN
      WITH changed_claims AS (
        UPDATE waiver_claims
           SET status = 'cancelled',
               failure_reason = 'The selected drop player left this roster in another transaction.',
               processed_at = now(),
               drop_player_id = NULL
         WHERE status = 'pending'
           AND league_id = OLD.league_id
           AND league_season_id = OLD.league_season_id
           AND member_id = OLD.member_id
           AND drop_player_id = OLD.player_id
         RETURNING id, member_id, failure_reason
      )
      INSERT INTO notification_outbox(dedupe_key,member_id,event_type,title,body,data,category)
      SELECT 'trade_claim_cancelled:'||id,member_id,'trade_claim_cancelled','Waiver claim cancelled',failure_reason,
        jsonb_build_object('claimId',id),'trade'
      FROM changed_claims
      ON CONFLICT (dedupe_key) DO NOTHING;
    ELSE
      UPDATE waiver_claims
         SET drop_player_id = NULL
       WHERE status = 'pending'
         AND league_id = OLD.league_id
         AND league_season_id = OLD.league_season_id
         AND member_id = OLD.member_id
         AND drop_player_id = OLD.player_id;
    END IF;

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
  v_drop record;
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
    SELECT DISTINCT player_id FROM (
      SELECT player_id FROM trade_items WHERE trade_id=p_trade_id AND player_id IS NOT NULL
      UNION SELECT unnest(drop_player_ids) FROM trade_participants WHERE trade_id=p_trade_id
    ) touched ORDER BY player_id ASC
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

  PERFORM private.validate_trade_rosters(p_trade_id);

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
         AND (v_league.allow_inactive_trades OR (is_on_ir = false AND is_on_taxi = false))
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
  IF v_league.allow_inactive_trades THEN
    FOR v_drop IN SELECT roster.* FROM trade_participants participant JOIN roster_players roster
      ON roster.member_id=participant.member_id AND roster.league_season_id=v_trade.league_season_id
        AND roster.player_id=ANY(participant.drop_player_ids)
      WHERE participant.trade_id=p_trade_id ORDER BY roster.player_id FOR UPDATE OF roster
    LOOP
      PERFORM private.release_roster_player_to_waivers(v_drop.id,v_trade.league_id,v_trade.league_season_id,
        v_drop.member_id,v_drop.player_id,'drop',NULL,p_trade_id);
    END LOOP;
  END IF;

  WITH changed_claims AS (
    UPDATE waiver_claims AS claim
       SET status = 'cancelled',
           failure_reason = 'The selected drop player left this roster in another transaction.',
           processed_at = now(),
           drop_player_id = NULL
     WHERE claim.status = 'pending'
       AND claim.league_id = v_trade.league_id
       AND claim.league_season_id = v_trade.league_season_id
       AND EXISTS (
         SELECT 1 FROM trade_items AS item
          WHERE item.trade_id = p_trade_id
            AND item.from_member_id = claim.member_id
            AND item.player_id = claim.drop_player_id
            AND (v_league.allow_inactive_trades OR item.to_taxi OR item.to_ir)
       )
     RETURNING claim.id, claim.member_id, claim.failure_reason
  )
  INSERT INTO notification_outbox(dedupe_key, member_id, event_type, title, body, data, category)
  SELECT 'trade_claim_cancelled:' || id, member_id, 'trade_claim_cancelled', 'Waiver claim cancelled',
    failure_reason, jsonb_build_object('claimId', id), 'trade'
  FROM changed_claims
  ON CONFLICT (dedupe_key) DO NOTHING;

  UPDATE waiver_claims AS claim
     SET drop_player_id = NULL
   WHERE claim.status = 'pending'
     AND claim.league_id = v_trade.league_id
     AND claim.league_season_id = v_trade.league_season_id
     AND EXISTS (
       SELECT 1 FROM trade_items AS item
        WHERE item.trade_id = p_trade_id
          AND item.from_member_id = claim.member_id
          AND item.player_id = claim.drop_player_id
     );

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := v_item.from_member_id;
    v_to_member := v_item.to_member_id;

    IF v_item.player_id IS NOT NULL THEN
      IF v_item.to_taxi OR v_league.allow_inactive_trades THEN
        PERFORM private.authorize_taxi_acquisition(v_trade.league_id,v_trade.league_season_id,v_to_member,v_item.player_id,'trade',p_trade_id);
      END IF;
      BEGIN
      UPDATE roster_players
         SET member_id = v_to_member,
             acquired_via = 'trade',
             is_on_taxi = v_item.to_taxi OR (v_league.allow_inactive_trades AND is_on_taxi),
             is_on_ir = CASE WHEN v_league.allow_inactive_trades THEN v_item.to_ir ELSE is_on_ir END
       WHERE league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = v_from_member
         AND player_id = v_item.player_id
         AND (v_league.allow_inactive_trades OR (is_on_ir = false AND is_on_taxi = false));

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Failed to move player asset atomically'
          USING ERRCODE = 'PT001';
      END IF;

      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        -- A game in progress only delays a taxi destination: keep the accepted trade for a later run.
        IF v_item.to_taxi AND SQLERRM LIKE 'This player''s game has already started%' THEN
          RAISE EXCEPTION 'A taxi destination waits for the player''s game slate to end.' USING ERRCODE='PT002';
        END IF;
        -- A changed destination precondition expires this trade, not the whole queue.
        RAISE EXCEPTION '% acquisition failed: %',
          CASE WHEN v_item.to_taxi THEN 'Taxi' WHEN v_item.to_ir THEN 'IR' ELSE 'Player' END,
          SQLERRM USING ERRCODE='PT001';
      END;

      INSERT INTO roster_transactions (
        league_id,
        league_season_id,
        member_id,
        player_id,
        transaction_type,
        acquired_to_taxi,
        related_trade_id
      )
      VALUES
        (v_trade.league_id, v_trade.league_season_id, v_from_member, v_item.player_id, 'trade_out', false, p_trade_id),
        (v_trade.league_id, v_trade.league_season_id, v_to_member, v_item.player_id, 'trade_in', v_item.to_taxi, p_trade_id);
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


CREATE OR REPLACE FUNCTION public.toggle_ir_atomic(p_roster_player_id uuid, p_to_ir boolean, p_user_id uuid)
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
  v_rookie_draft_id uuid;
  v_injury text;
  v_roster_size int;
  v_ir_slots int;
  v_other_ir_count int;
  v_active_count int;
  v_rows int;
BEGIN
  SELECT league_id, player_id, member_id
    INTO v_league_id, v_player_id, v_member_id
    FROM roster_players
   WHERE id = p_roster_player_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster player not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT draft.id INTO v_rookie_draft_id
    FROM drafts AS draft
    JOIN league_seasons AS season ON season.id = draft.league_season_id AND season.is_current
    JOIN leagues AS league ON league.id = draft.league_id AND league.status = 'drafting'
   WHERE draft.league_id = v_league_id
     AND draft.draft_type = 'snake' AND NOT draft.is_mock AND draft.status = 'completed'
   ORDER BY draft.created_at DESC LIMIT 1;
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(v_rookie_draft_id::text), 0);
    PERFORM 1 FROM drafts WHERE id = v_rookie_draft_id FOR UPDATE;
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
    RAISE EXCEPTION 'Roster player not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = v_rp.member_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this roster'
      USING ERRCODE = '42501';
  END IF;

  PERFORM v_member.id;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_rp.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status)
     AND NOT (v_league.status = 'offseason'::league_status AND p_to_ir = false) THEN
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

  IF private.roster_status_game_started(v_rp.player_id) THEN
    RAISE EXCEPTION 'This player''s game has already started. No roster status changes are allowed for that slate.'
      USING ERRCODE = 'P0001';
  END IF;

  v_roster_size := COALESCE(v_league.roster_size, 20);
  v_ir_slots := COALESCE(v_league.ir_slots, 2);

  IF p_to_ir THEN
    SELECT p.injury_status
      INTO v_injury
      FROM players p
     WHERE p.id = v_rp.player_id;

    IF NOT private.is_ir_designation(v_injury) THEN
      RAISE EXCEPTION 'Only players with Out or IR designations can be placed on IR.'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT count(*)
      INTO v_other_ir_count
      FROM roster_players
     WHERE member_id = v_rp.member_id
       AND league_season_id = v_rp.league_season_id
       AND is_on_ir = true
       AND id <> p_roster_player_id;

    IF v_other_ir_count >= v_ir_slots THEN
      RAISE EXCEPTION 'You only have % IR slot%.', v_ir_slots, CASE WHEN v_ir_slots = 1 THEN '' ELSE 's' END
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT count(*)
      INTO v_active_count
      FROM roster_players
     WHERE member_id = v_rp.member_id
       AND league_season_id = v_rp.league_season_id
       AND is_on_ir = false
       AND is_on_taxi = false
       AND id <> p_roster_player_id;

    IF v_active_count >= v_roster_size THEN
      RAISE EXCEPTION 'Your active roster is full (% players).', v_roster_size
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE roster_players
     SET is_on_ir = p_to_ir,
         is_on_taxi = CASE WHEN p_to_ir THEN false ELSE is_on_taxi END
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to toggle IR status'
      USING ERRCODE = 'P0001';
  END IF;

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
    CASE WHEN p_to_ir THEN 'ir_designate' ELSE 'ir_return' END
  );
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM private.activate_rookie_draft_league_if_ready(v_rookie_draft_id);
  END IF;
END;
$function$;


CREATE OR REPLACE FUNCTION public.activate_roster_player_with_overflow_atomic(
  p_activate_roster_player_id uuid,
  p_activate_source text,
  p_free_roster_player_id uuid,
  p_free_action text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required.'
      USING ERRCODE = '42501';
  END IF;

  IF p_activate_roster_player_id = p_free_roster_player_id THEN
    RAISE EXCEPTION 'Activation target and freed roster slot must be different players.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_roster_activation(
    p_activate_roster_player_id, p_activate_source, p_free_roster_player_id
  );

  CASE p_free_action
    WHEN 'drop' THEN
      PERFORM public.drop_player_atomic(p_free_roster_player_id);
    WHEN 'ir' THEN
      PERFORM public.toggle_ir_atomic(p_free_roster_player_id, true, v_user_id);
    ELSE
      RAISE EXCEPTION 'Invalid roster overflow action: %', p_free_action
        USING ERRCODE = '22023';
  END CASE;

  CASE p_activate_source
    WHEN 'ir' THEN
      PERFORM public.toggle_ir_atomic(p_activate_roster_player_id, false, v_user_id);
    WHEN 'taxi' THEN
      PERFORM public.toggle_taxi_atomic(p_activate_roster_player_id, false, v_user_id);
    ELSE
      RAISE EXCEPTION 'Invalid activation source: %', p_activate_source
        USING ERRCODE = '22023';
  END CASE;
END;
$$;


CREATE OR REPLACE FUNCTION public.activate_roster_player_with_lineup_atomic(
  p_activate_roster_player_id uuid,
  p_activate_source text,
  p_free_roster_player_id uuid,
  p_free_action text,
  p_member_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_game_date date,
  p_week_number int,
  p_slot_type roster_slot_type DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_activate_player_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required.'
      USING ERRCODE = '42501';
  END IF;

  IF (p_free_roster_player_id IS NULL AND p_free_action IS NOT NULL)
     OR (p_free_roster_player_id IS NOT NULL AND p_free_action IS NULL) THEN
    RAISE EXCEPTION 'Overflow player and overflow action must be provided together.'
      USING ERRCODE = '22023';
  END IF;

  IF p_free_roster_player_id IS NOT NULL
     AND p_activate_roster_player_id = p_free_roster_player_id THEN
    RAISE EXCEPTION 'Activation target and freed roster slot must be different players.'
      USING ERRCODE = '22023';
  END IF;

  IF p_slot_type = 'IR'::roster_slot_type THEN
    RAISE EXCEPTION 'Use roster IR actions instead of lineup IR assignment.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_roster_activation(
    p_activate_roster_player_id, p_activate_source, p_free_roster_player_id
  );

  IF NOT EXISTS (
    SELECT 1 FROM roster_players WHERE id = p_activate_roster_player_id
      AND member_id = p_member_id AND league_id = p_league_id AND league_season_id = p_league_season_id
  ) THEN
    RAISE EXCEPTION 'Activated player is not on this roster.' USING ERRCODE = 'P0002';
  END IF;

  IF p_free_roster_player_id IS NOT NULL THEN
    CASE p_free_action
      WHEN 'drop' THEN
        PERFORM public.drop_player_atomic(p_free_roster_player_id);
      WHEN 'ir' THEN
        PERFORM public.toggle_ir_atomic(p_free_roster_player_id, true, v_user_id);
      ELSE
        RAISE EXCEPTION 'Invalid roster overflow action: %', p_free_action
          USING ERRCODE = '22023';
    END CASE;
  END IF;

  CASE p_activate_source
    WHEN 'ir' THEN
      PERFORM public.toggle_ir_atomic(p_activate_roster_player_id, false, v_user_id);
    WHEN 'taxi' THEN
      PERFORM public.toggle_taxi_atomic(p_activate_roster_player_id, false, v_user_id);
    ELSE
      RAISE EXCEPTION 'Invalid activation source: %', p_activate_source
        USING ERRCODE = '22023';
  END CASE;

  IF p_slot_type IS NOT NULL AND p_slot_type <> 'BE'::roster_slot_type THEN
    SELECT player_id
      INTO v_activate_player_id
      FROM public.roster_players
     WHERE id = p_activate_roster_player_id
       AND member_id = p_member_id
       AND league_id = p_league_id
       AND league_season_id = p_league_season_id;

    IF v_activate_player_id IS NULL THEN
      RAISE EXCEPTION 'Activated player is not on this roster.'
        USING ERRCODE = 'P0002';
    END IF;

    PERFORM public.set_player_slot_atomic(
      p_member_id,
      p_league_id,
      p_league_season_id,
      v_activate_player_id,
      p_game_date,
      p_slot_type,
      p_week_number
    );
  END IF;
END;
$$;

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
    WITH changed_claims AS (UPDATE waiver_claims
       SET status = CASE WHEN v_cancel_claims THEN 'cancelled'::waiver_claim_status ELSE status END,
           failure_reason = CASE WHEN v_cancel_claims THEN 'The selected drop player left this roster in another transaction.' ELSE failure_reason END,
           processed_at = CASE WHEN v_cancel_claims THEN now() ELSE processed_at END,
           drop_player_id = NULL
     WHERE status = 'pending'::waiver_claim_status
       AND league_id = OLD.league_id
       AND league_season_id = OLD.league_season_id
       AND member_id = OLD.member_id
       AND drop_player_id = OLD.player_id
     RETURNING id,member_id,failure_reason,status)
    INSERT INTO notification_outbox(dedupe_key,member_id,event_type,title,body,data,category)
    SELECT 'trade_claim_cancelled:'||id,id_member,'trade_claim_cancelled','Waiver claim cancelled',failure_reason,
      jsonb_build_object('claimId',id),'trade'
    FROM (SELECT id,member_id AS id_member,failure_reason FROM changed_claims WHERE status='cancelled') cancelled
    WHERE private.trade_lifecycle_write_active()
    ON CONFLICT (dedupe_key) DO NOTHING;

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
       )
     RETURNING claim.id, claim.member_id, claim.failure_reason
  )
  INSERT INTO notification_outbox(dedupe_key, member_id, event_type, title, body, data, category)
  SELECT 'trade_claim_cancelled:' || id, member_id, 'trade_claim_cancelled', 'Waiver claim cancelled',
    failure_reason, jsonb_build_object('claimId', id), 'trade'
  FROM changed_claims
  ON CONFLICT (dedupe_key) DO NOTHING;

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


CREATE OR REPLACE FUNCTION public.get_league_activity_feed(
  p_league_id uuid,
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  member_id uuid,
  target_member_id uuid,
  team_name text,
  target_team_name text,
  player_id uuid,
  player_name text,
  player_position text,
  eligible_positions text[],
  nba_id text,
  transaction_type text,
  occurred_at timestamptz,
  is_system boolean,
  title text,
  body text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE league_id = p_league_id
     AND user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH current_season AS (
    SELECT season.id
      FROM league_seasons AS season
     WHERE season.league_id = p_league_id
       AND season.is_current = true
     LIMIT 1
  ),
  feed AS (
    SELECT
      tx.id,
      tx.member_id,
      NULL::uuid AS target_member_id,
      member.team_name::text AS team_name,
      NULL::text AS target_team_name,
      tx.player_id,
      player.display_name::text AS player_name,
      player.position::text AS player_position,
      player.eligible_positions::text[] AS eligible_positions,
      player.nba_id::text AS nba_id,
      tx.transaction_type::text AS transaction_type,
      tx.occurred_at,
      false AS is_system,
      NULL::text AS title,
      NULL::text AS body
    FROM roster_transactions AS tx
    JOIN current_season ON current_season.id = tx.league_season_id
    LEFT JOIN league_members AS member ON member.id = tx.member_id
    LEFT JOIN players AS player ON player.id = tx.player_id
    WHERE tx.league_id = p_league_id
      AND tx.transaction_type IN ('fa_add', 'fa_drop', 'waiver_add', 'waiver_drop', 'trade_in', 'trade_out', 'draft_won', 'carry_over')

    UNION ALL

    SELECT
      activity.id,
      activity.actor_member_id AS member_id,
      activity.target_member_id,
      COALESCE(actor.team_name, 'League')::text AS team_name,
      target.team_name::text AS target_team_name,
      activity.related_player_id AS player_id,
      COALESCE(player.display_name, activity.title)::text AS player_name,
      player.position::text AS player_position,
      player.eligible_positions::text[] AS eligible_positions,
      player.nba_id::text AS nba_id,
      activity.event_type::text AS transaction_type,
      activity.created_at AS occurred_at,
      true AS is_system,
      activity.title,
      activity.body
    FROM league_activity AS activity
    JOIN current_season
      ON activity.league_season_id = current_season.id
      OR activity.league_season_id IS NULL
    LEFT JOIN league_members AS actor ON actor.id = activity.actor_member_id
    LEFT JOIN league_members AS target ON target.id = activity.target_member_id
    LEFT JOIN players AS player ON player.id = activity.related_player_id
    WHERE activity.league_id = p_league_id
      AND activity.event_type NOT IN ('trade_block_updated', 'free_agent_added')
      AND (activity.event_type NOT IN ('trade_offered', 'trade_countered', 'trade_edited')
        OR private.can_read_trade(activity.related_trade_id))
  )
  SELECT
    feed.id,
    feed.member_id,
    feed.target_member_id,
    feed.team_name,
    feed.target_team_name,
    feed.player_id,
    feed.player_name,
    feed.player_position,
    feed.eligible_positions,
    feed.nba_id,
    feed.transaction_type,
    feed.occurred_at,
    feed.is_system,
    feed.title,
    feed.body
  FROM feed
  ORDER BY feed.occurred_at DESC, feed.id DESC
  LIMIT v_limit
  OFFSET v_offset;
END;
$$;

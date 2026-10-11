BEGIN;

-- Canonical SQL source for private.replace_trade_offer.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.replace_trade_offer(
  p_trade_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_action text,
  p_offer_player_ids uuid[],
  p_request_player_ids uuid[],
  p_offer_pick_ids uuid[],
  p_request_pick_ids uuid[],
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_offer_faab_amount int DEFAULT 0,
  p_request_faab_amount int DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_new_trade_id uuid;
  v_parent_trade_id uuid;
  v_new_proposer_member_id uuid;
  v_new_recipient_member_id uuid;
  v_replaced_status trade_status;
  v_countered_from_trade_id uuid := NULL;
  v_edited_from_trade_id uuid := NULL;
  v_pending_error text;
  v_actor_error text;
BEGIN
  IF p_action NOT IN ('counter', 'edit') THEN
    RAISE EXCEPTION 'Unsupported trade replacement action.'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found.' USING ERRCODE = 'P0002';
  END IF;

  -- Include the source assets even when the replacement removes them. A drop
  -- expires that source while holding the same team and player locks.
  PERFORM private.lock_trade_offer_assets(
    v_trade.league_id,
    ARRAY(SELECT member_id FROM trade_participants WHERE trade_id = p_trade_id) || ARRAY[v_trade.proposer_member_id, v_trade.recipient_member_id],
    ARRAY(SELECT player_id FROM trade_items WHERE trade_id = p_trade_id AND player_id IS NOT NULL) ||
      COALESCE(p_offer_player_ids, ARRAY[]::uuid[]) || COALESCE(p_request_player_ids, ARRAY[]::uuid[])
  );

  -- Accepted completion owns its trade row before team locks. A stale pending
  -- action must not wait on that row while holding its team locks.
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
     AND status = 'pending'::trade_status
   FOR UPDATE;

  IF NOT FOUND THEN
    SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF COALESCE(v_trade.is_multi_team, false) THEN
    RAISE EXCEPTION 'Use the multi-team action for this trade.' USING ERRCODE = '22023';
  END IF;

  IF p_action = 'counter' THEN
    v_new_proposer_member_id := p_member_id;
    v_new_recipient_member_id := v_trade.proposer_member_id;
    v_replaced_status := 'countered'::trade_status;
    v_countered_from_trade_id := p_trade_id;
    v_pending_error := 'Only pending offers can be countered.';
    v_actor_error := 'Only the recipient can counter this offer.';
  ELSE
    v_new_proposer_member_id := p_member_id;
    v_new_recipient_member_id := v_trade.recipient_member_id;
    v_replaced_status := 'edited'::trade_status;
    v_edited_from_trade_id := p_trade_id;
    v_pending_error := 'Only pending offers can be edited.';
    v_actor_error := 'Only the proposer can edit this offer.';
  END IF;


  IF (
    (p_action = 'counter' AND v_trade.recipient_member_id <> p_member_id)
    OR (p_action = 'edit' AND v_trade.proposer_member_id <> p_member_id)
  ) THEN
    RAISE EXCEPTION '%', v_actor_error
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND user_id = p_user_id
     AND league_id = v_trade.league_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to act for this member.'
      USING ERRCODE = '42501';
  END IF;

  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION '%', v_pending_error
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.expires_at IS NOT NULL AND v_trade.expires_at <= now() THEN
    UPDATE trades SET status = 'expired'::trade_status WHERE id = p_trade_id;
    RETURN NULL;
  END IF;

  v_parent_trade_id := COALESCE(v_trade.parent_trade_id, v_trade.id);

  v_new_trade_id := private.create_trade_offer(
    v_trade.league_id,
    v_trade.league_season_id,
    v_new_proposer_member_id,
    v_new_recipient_member_id,
    p_offer_player_ids,
    p_request_player_ids,
    p_offer_pick_ids,
    p_request_pick_ids,
    p_notes,
    p_expires_at,
    p_offer_faab_amount,
    p_request_faab_amount,
    v_parent_trade_id,
    v_countered_from_trade_id,
    v_edited_from_trade_id,
    v_trade.version + 1
  );

  UPDATE trades
     SET status = v_replaced_status,
         replaced_by_trade_id = v_new_trade_id
   WHERE id = p_trade_id
     AND status = 'pending'::trade_status;

  RETURN v_new_trade_id;
END;
$$;

-- Canonical SQL source for private.replace_multi_team_trade_offer.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.replace_multi_team_trade_offer(
  p_trade_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_action text,
  p_participant_member_ids uuid[],
  p_items jsonb,
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_new_trade trades%ROWTYPE;
  v_new_trade_id uuid;
  v_parent_trade_id uuid;
  v_new_proposer_member_id uuid;
  v_replaced_status trade_status;
  v_countered_from_trade_id uuid := NULL;
  v_edited_from_trade_id uuid := NULL;
  v_pending_error text;
  v_actor_error text;
BEGIN
  IF p_action NOT IN ('counter', 'edit') THEN
    RAISE EXCEPTION 'Unsupported trade replacement action.'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found.' USING ERRCODE = 'P0002';
  END IF;

  -- Include the source assets even when the replacement removes them. A drop
  -- expires that source while holding the same team and player locks.
  PERFORM private.lock_trade_offer_assets(
    v_trade.league_id,
    ARRAY(SELECT member_id FROM trade_participants WHERE trade_id = p_trade_id) || ARRAY(SELECT member_id FROM private.multi_team_trade_participants(p_member_id, p_participant_member_ids)),
    ARRAY(SELECT player_id FROM trade_items WHERE trade_id = p_trade_id AND player_id IS NOT NULL) ||
      ARRAY(SELECT player_id FROM private.parse_multi_team_trade_items(p_items) WHERE player_id IS NOT NULL)
  );

  -- Accepted completion owns its trade row before team locks. A stale pending
  -- action must not wait on that row while holding its team locks.
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
     AND status = 'pending'::trade_status
   FOR UPDATE;

  IF NOT FOUND THEN
    SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF COALESCE(v_trade.is_multi_team, false) = false THEN
    RAISE EXCEPTION 'This action only supports multi-team trades.'
      USING ERRCODE = '22023';
  END IF;

  IF p_action = 'counter' THEN
    v_new_proposer_member_id := p_member_id;
    v_replaced_status := 'countered'::trade_status;
    v_countered_from_trade_id := p_trade_id;
    v_pending_error := 'Only pending offers can be countered.';
    v_actor_error := 'Only a non-proposer trade participant can counter this offer.';
  ELSE
    v_new_proposer_member_id := p_member_id;
    v_replaced_status := 'edited'::trade_status;
    v_edited_from_trade_id := p_trade_id;
    v_pending_error := 'Only pending offers can be edited.';
    v_actor_error := 'Only the proposer can edit this offer.';
  END IF;


  IF p_action = 'counter' THEN
    IF v_trade.proposer_member_id = p_member_id OR NOT EXISTS (
      SELECT 1
        FROM trade_participants AS participant
       WHERE participant.trade_id = p_trade_id
         AND participant.member_id = p_member_id
         AND participant.accepted_at IS NULL
    ) THEN
      RAISE EXCEPTION '%', v_actor_error
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_trade.proposer_member_id <> p_member_id THEN
    RAISE EXCEPTION '%', v_actor_error
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND user_id = p_user_id
     AND league_id = v_trade.league_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to act for this member.'
      USING ERRCODE = '42501';
  END IF;

  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION '%', v_pending_error
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.expires_at IS NOT NULL AND v_trade.expires_at <= now() THEN
    UPDATE trades SET status = 'expired'::trade_status WHERE id = p_trade_id;
    RETURN NULL;
  END IF;

  v_parent_trade_id := COALESCE(v_trade.parent_trade_id, v_trade.id);

  v_new_trade_id := private.create_multi_team_trade_offer(
    v_trade.league_id,
    v_trade.league_season_id,
    v_new_proposer_member_id,
    p_participant_member_ids,
    p_items,
    p_notes,
    p_expires_at,
    v_parent_trade_id,
    v_countered_from_trade_id,
    v_edited_from_trade_id,
    v_trade.version + 1
  );

  SELECT * INTO v_new_trade FROM trades WHERE id = v_new_trade_id;

  DELETE FROM league_activity
   WHERE related_trade_id = v_new_trade_id
     AND event_type = 'trade_offered';

  PERFORM private.log_league_activity(
    v_trade.league_id,
    v_trade.league_season_id,
    CASE
      WHEN v_countered_from_trade_id IS NOT NULL THEN 'trade_countered'
      ELSE 'trade_edited'
    END,
    CASE
      WHEN v_countered_from_trade_id IS NOT NULL THEN 'Multi-team counteroffer sent'
      ELSE 'Multi-team trade offer edited'
    END,
    NULL,
    v_new_trade.proposer_member_id,
    v_new_trade.recipient_member_id,
    NULL,
    v_new_trade_id,
    NULL,
    jsonb_build_object(
      'is_multi_team', true,
      'parent_trade_id', v_parent_trade_id,
      'countered_from_trade_id', v_countered_from_trade_id,
      'edited_from_trade_id', v_edited_from_trade_id,
      'version', v_trade.version + 1
    )
  );

  UPDATE trades
     SET status = v_replaced_status,
         replaced_by_trade_id = v_new_trade_id
   WHERE id = p_trade_id
     AND status = 'pending'::trade_status;

  RETURN v_new_trade_id;
END;
$$;

-- Canonical SQL source for private.accept_trade_participant_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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

  -- Accepted completion owns its trade row before team locks. A stale pending
  -- action must not wait on that row while holding its team locks.
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
     AND status = 'pending'::trade_status
   FOR UPDATE;

  IF NOT FOUND THEN
    SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.expires_at IS NOT NULL AND v_trade.expires_at <= now() THEN
    UPDATE trades SET status = 'expired'::trade_status
     WHERE id = p_trade_id AND status = 'pending'::trade_status;
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

-- Canonical SQL source for public.set_trade_taxi_destinations_atomic.
-- Keep the latest migration definition identical.

CREATE OR REPLACE FUNCTION public.set_trade_taxi_destinations_atomic(p_trade_id uuid,p_member_id uuid,p_player_ids uuid[],p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE v_trade trades%ROWTYPE; v_player_id uuid; v_member_id uuid; v_slots int; v_count int;
BEGIN
  SELECT * INTO v_trade FROM trades WHERE id=p_trade_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trade not found' USING ERRCODE='P0002'; END IF;
  IF NOT EXISTS(SELECT 1 FROM league_members WHERE id=p_member_id AND league_id=v_trade.league_id AND user_id=p_user_id) THEN
    RAISE EXCEPTION 'Not authorized to choose this roster destination.' USING ERRCODE='42501';
  END IF;
  -- Match acceptance and roster mutations: members, players, then the trade.
  FOR v_member_id IN SELECT member_id FROM trade_participants WHERE trade_id=p_trade_id ORDER BY member_id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text),hashtext(v_member_id::text));
  END LOOP;
  FOR v_player_id IN SELECT DISTINCT player_id FROM trade_items WHERE trade_id=p_trade_id AND player_id IS NOT NULL ORDER BY player_id LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text),hashtext(v_player_id::text));
  END LOOP;
  SELECT * INTO v_trade FROM trades WHERE id=p_trade_id AND status='pending' FOR UPDATE;
  IF NOT FOUND THEN SELECT * INTO v_trade FROM trades WHERE id=p_trade_id; END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trade not found' USING ERRCODE='P0002'; END IF;
  IF v_trade.status<>'pending' OR (v_trade.expires_at IS NOT NULL AND v_trade.expires_at<=now()) THEN
    RAISE EXCEPTION 'Choose roster destinations while the trade offer is pending.' USING ERRCODE='P0001';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM trade_items WHERE trade_id=p_trade_id AND to_member_id=p_member_id) THEN
    RAISE EXCEPTION 'This member receives no assets in this trade.' USING ERRCODE='42501';
  END IF;
  IF p_player_ids IS NULL OR cardinality(p_player_ids)>100 OR EXISTS(SELECT 1 FROM unnest(p_player_ids) p GROUP BY p HAVING p IS NULL OR count(*)>1) THEN
    RAISE EXCEPTION 'Taxi selections must be a unique list of incoming players.' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM unnest(p_player_ids) p WHERE NOT EXISTS(SELECT 1 FROM trade_items WHERE trade_id=p_trade_id AND to_member_id=p_member_id AND player_id=p)) THEN
    RAISE EXCEPTION 'Taxi selections must belong to the receiving team.' USING ERRCODE='42501';
  END IF;
  FOR v_player_id IN SELECT p FROM unnest(p_player_ids) p ORDER BY p LOOP
    PERFORM private.assert_taxi_acquisition_allowed(v_trade.league_id,v_trade.league_season_id,p_member_id,v_player_id);
  END LOOP;
  SELECT taxi_slots INTO v_slots FROM leagues WHERE id=v_trade.league_id FOR UPDATE;
  SELECT count(*) INTO v_count FROM roster_players WHERE league_id=v_trade.league_id AND league_season_id=v_trade.league_season_id AND member_id=p_member_id AND is_on_taxi;
  IF v_count+cardinality(p_player_ids)>COALESCE(v_slots,0) THEN
    RAISE EXCEPTION 'The selected players exceed your available taxi slots.' USING ERRCODE='P0001';
  END IF;
  UPDATE trade_items SET to_taxi=player_id=ANY(p_player_ids) WHERE trade_id=p_trade_id AND to_member_id=p_member_id AND player_id IS NOT NULL;
END;
$$;

COMMIT;

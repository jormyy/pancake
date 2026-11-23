-- Canonical SQL source for private.trade_lock_keys.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.trade_lock_keys(p_trade_ids uuid[])
RETURNS TABLE (league_id uuid, kind int, id uuid)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT DISTINCT trade.league_id, key.kind, key.id
    FROM trades AS trade
    CROSS JOIN LATERAL (
      SELECT 1, trade.proposer_member_id
      UNION SELECT 1, trade.recipient_member_id
      UNION SELECT 1, participant.member_id FROM trade_participants AS participant WHERE participant.trade_id = trade.id
      UNION SELECT 2, item.player_id FROM trade_items AS item WHERE item.trade_id = trade.id
      UNION SELECT 2, unnest(participant.drop_player_ids) FROM trade_participants AS participant WHERE participant.trade_id = trade.id
      UNION SELECT 2, (move->>'playerId')::uuid
        FROM trade_participants AS participant, jsonb_array_elements(participant.roster_moves) AS move
       WHERE participant.trade_id = trade.id
    ) AS key(kind, id)
   WHERE trade.id = ANY(p_trade_ids)
     AND key.id IS NOT NULL;
$$;

-- Canonical SQL source for private.begin_trade_action.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.begin_trade_action(
  p_trade_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_action text,
  p_member_ids uuid[] DEFAULT '{}',
  p_player_ids uuid[] DEFAULT '{}'
)
RETURNS public.trades
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_league_id uuid;
  v_pass int;
  v_key record;
  v_participant trade_participants%ROWTYPE;
  v_is_party boolean;
  v_wait boolean := NOT EXISTS (
    SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
  );
BEGIN
  IF p_action IS NULL OR p_action NOT IN (
    'propose','edit','counter','accept','reject','withdraw','retract','veto','plan','taxi','complete'
  ) OR (p_trade_id IS NULL) <> (p_action = 'propose')
    OR (p_member_id IS NULL) <> (p_action = 'complete')
    OR (p_action = 'propose' AND p_user_id IS NULL) THEN
    RAISE EXCEPTION 'Unsupported trade action.' USING ERRCODE = '22023';
  END IF;

  IF p_trade_id IS NULL THEN
    SELECT league_id INTO v_league_id FROM league_members WHERE id = p_member_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Not authorized to act for this member.' USING ERRCODE = '42501';
    END IF;
  ELSE
    SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Trade not found.' USING ERRCODE = 'P0002';
    END IF;
    v_league_id := v_trade.league_id;
  END IF;

  FOR v_pass IN 1..2 LOOP
    FOR v_key IN
      SELECT kind, id FROM (
        SELECT key.kind, key.id FROM private.trade_lock_keys(ARRAY[p_trade_id]) AS key
        UNION SELECT 1, unnest(p_member_ids)
        UNION SELECT 2, unnest(p_player_ids)
      ) AS keys
      WHERE id IS NOT NULL
      ORDER BY kind, id
    LOOP
      IF v_pass = 1 AND v_wait THEN
        PERFORM pg_advisory_xact_lock(hashtext(v_league_id::text), hashtext(v_key.id::text));
      ELSIF NOT pg_try_advisory_xact_lock(hashtext(v_league_id::text), hashtext(v_key.id::text)) THEN
        RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE = 'PA010';
      END IF;
    END LOOP;
    EXIT WHEN v_pass = 2;

    BEGIN
      PERFORM 1 FROM league_members
       WHERE id = p_member_id
         AND league_id = v_league_id
         AND (p_user_id IS NULL OR user_id = p_user_id)
       FOR SHARE NOWAIT;
      IF p_member_id IS NOT NULL AND NOT FOUND THEN
        RAISE EXCEPTION '%', CASE p_action
          WHEN 'plan' THEN 'Only the receiving manager can choose placements and drops.'
          ELSE 'Not authorized to act for this member.'
        END USING ERRCODE = '42501';
      END IF;
      IF p_trade_id IS NULL THEN
        RETURN v_trade;
      END IF;
      SELECT * INTO v_trade FROM trades WHERE id = p_trade_id FOR NO KEY UPDATE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE = 'PA010';
    END;
  END LOOP;

  SELECT * INTO v_participant FROM trade_participants WHERE trade_id = p_trade_id AND member_id = p_member_id;
  v_is_party := v_participant.member_id IS NOT NULL
    OR p_member_id IN (v_trade.proposer_member_id, v_trade.recipient_member_id);

  IF p_action IN ('accept', 'retract') AND v_participant.member_id IS NULL THEN
    RAISE EXCEPTION 'Only a trade participant can % this trade.', p_action USING ERRCODE = '42501';
  ELSIF p_action = 'plan' AND v_participant.member_id IS NULL THEN
    RAISE EXCEPTION 'Only the receiving manager can choose placements and drops.' USING ERRCODE = '42501';
  ELSIF p_action = 'taxi' AND NOT EXISTS (
    SELECT 1 FROM trade_items WHERE trade_id = p_trade_id AND to_member_id = p_member_id
  ) THEN
    RAISE EXCEPTION 'This member receives no assets in this trade.' USING ERRCODE = '42501';
  ELSIF p_action IN ('withdraw', 'edit') AND v_trade.proposer_member_id IS DISTINCT FROM p_member_id THEN
    RAISE EXCEPTION '%', CASE p_action
      WHEN 'withdraw' THEN 'Only the trade proposer can withdraw this trade.'
      ELSE 'Only the proposer can edit this offer.'
    END USING ERRCODE = '42501';
  ELSIF p_action IN ('reject', 'counter') AND COALESCE(v_trade.is_multi_team, false)
    AND (v_trade.proposer_member_id = p_member_id OR v_participant.member_id IS NULL OR v_participant.accepted_at IS NOT NULL) THEN
    RAISE EXCEPTION '%', CASE p_action
      WHEN 'reject' THEN 'Only a non-proposer trade participant can reject this trade.'
      ELSE 'Only a non-proposer trade participant can counter this offer.'
    END USING ERRCODE = '42501';
  ELSIF p_action IN ('reject', 'counter') AND NOT COALESCE(v_trade.is_multi_team, false)
    AND v_trade.recipient_member_id IS DISTINCT FROM p_member_id THEN
    RAISE EXCEPTION '%', CASE p_action
      WHEN 'reject' THEN 'Only the trade recipient can reject this trade.'
      ELSE 'Only the recipient can counter this offer.'
    END USING ERRCODE = '42501';
  ELSIF p_action = 'veto' AND v_is_party THEN
    RAISE EXCEPTION 'Trade parties cannot veto their own trade.' USING ERRCODE = 'P0001';
  END IF;

  RETURN v_trade;
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
  v_rows int;
  v_all_accepted boolean;
  v_veto_window_hours int;
BEGIN
  PERFORM set_config('pancake.trade_write','true',true);
  PERFORM set_config('lock_timeout','100ms',true);
  v_trade := private.begin_trade_action(p_trade_id, p_accepting_member_id, NULL, 'accept');

  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
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
   FOR NO KEY UPDATE NOWAIT;

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
   FOR NO KEY UPDATE NOWAIT;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trades require the current season.'
      USING ERRCODE = 'P0001';
  END IF;


  PERFORM private.assert_trade_window(v_trade.league_id,
    ARRAY(SELECT pick_id FROM trade_items WHERE trade_id=p_trade_id AND pick_id IS NOT NULL));

  SELECT NOT EXISTS (SELECT 1 FROM trade_participants
    WHERE trade_id=p_trade_id AND member_id<>p_accepting_member_id AND accepted_at IS NULL)
    INTO v_all_accepted;

  PERFORM private.assert_trade_assets_acceptance_ready(
    p_trade_id,
    v_trade.league_id,
    v_trade.league_season_id,
    CASE WHEN v_all_accepted THEN NULL ELSE p_accepting_member_id END,
    p_accepting_member_id
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

  END IF;

  IF v_all_accepted THEN
    PERFORM private.work_enqueue('trade-activation',p_trade_id::text,now(),jsonb_build_object('tradeId',p_trade_id));
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
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE='PA010';
END;
$$;

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
BEGIN
  IF p_action NOT IN ('counter', 'edit') THEN
    RAISE EXCEPTION 'Unsupported trade replacement action.'
      USING ERRCODE = '22023';
  END IF;

  v_trade := private.begin_trade_action(p_trade_id, p_member_id, p_user_id, p_action, '{}',
    COALESCE(p_offer_player_ids, '{}') || COALESCE(p_request_player_ids, '{}'));

  IF COALESCE(v_trade.is_multi_team, false) THEN
    RAISE EXCEPTION 'Use the multi-team action for this trade.' USING ERRCODE = '22023';
  END IF;

  IF p_action = 'counter' THEN
    v_new_proposer_member_id := p_member_id;
    v_new_recipient_member_id := v_trade.proposer_member_id;
    v_replaced_status := 'countered'::trade_status;
    v_countered_from_trade_id := p_trade_id;
    v_pending_error := 'Only pending offers can be countered.';
  ELSE
    v_new_proposer_member_id := p_member_id;
    v_new_recipient_member_id := v_trade.recipient_member_id;
    v_replaced_status := 'edited'::trade_status;
    v_edited_from_trade_id := p_trade_id;
    v_pending_error := 'Only pending offers can be edited.';
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
BEGIN
  IF p_action NOT IN ('counter', 'edit') THEN
    RAISE EXCEPTION 'Unsupported trade replacement action.'
      USING ERRCODE = '22023';
  END IF;

  v_trade := private.begin_trade_action(p_trade_id, p_member_id, p_user_id, p_action,
    ARRAY(SELECT member_id FROM private.multi_team_trade_participants(p_member_id, p_participant_member_ids)),
    ARRAY(SELECT player_id FROM private.parse_multi_team_trade_items(p_items) WHERE player_id IS NOT NULL));

  IF COALESCE(v_trade.is_multi_team, false) = false THEN
    RAISE EXCEPTION 'This action only supports multi-team trades.'
      USING ERRCODE = '22023';
  END IF;

  IF p_action = 'counter' THEN
    v_new_proposer_member_id := p_member_id;
    v_replaced_status := 'countered'::trade_status;
    v_countered_from_trade_id := p_trade_id;
    v_pending_error := 'Only pending offers can be countered.';
  ELSE
    v_new_proposer_member_id := p_member_id;
    v_replaced_status := 'edited'::trade_status;
    v_edited_from_trade_id := p_trade_id;
    v_pending_error := 'Only pending offers can be edited.';
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

-- Canonical SQL source for public.accept_trade_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.accept_trade_atomic(
  p_trade_id uuid,
  p_accepting_member_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
  __request_result jsonb;
BEGIN
  PERFORM private.begin_trade_action(p_trade_id, p_accepting_member_id, NULL, 'accept');
  __request_context := private.request_begin('public.accept_trade_atomic', jsonb_build_array(p_trade_id, p_accepting_member_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
BEGIN
  __request_result := private.accept_trade_participant_atomic(
    p_trade_id,
    p_accepting_member_id
  ); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

-- Canonical SQL source for public.accept_trade_with_plan_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.accept_trade_with_plan_atomic(
  p_trade_id uuid,p_member_id uuid,p_user_id uuid,
  p_taxi_player_ids uuid[],p_ir_player_ids uuid[],p_drop_player_ids uuid[],p_roster_moves jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  __request_context jsonb;
  __request_result jsonb;
BEGIN
  PERFORM private.begin_trade_action(p_trade_id, p_member_id, p_user_id, 'accept');
  __request_context := private.request_begin('public.accept_trade_with_plan_atomic', jsonb_build_array(p_trade_id, p_member_id, p_user_id, p_taxi_player_ids, p_ir_player_ids, p_drop_player_ids, p_roster_moves), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
BEGIN
  PERFORM public.set_trade_roster_plan_atomic(p_trade_id,p_member_id,p_user_id,p_taxi_player_ids,p_ir_player_ids,p_drop_player_ids,p_roster_moves);
  __request_result := public.accept_trade_atomic(p_trade_id,p_member_id); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

-- Canonical SQL source for public.reject_trade_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
  __request_context jsonb;
  __request_result jsonb;
  v_trade trades%ROWTYPE;
BEGIN
  v_trade := private.begin_trade_action(p_trade_id, p_member_id, p_user_id, 'reject');
  __request_context := private.request_begin('public.reject_trade_atomic', jsonb_build_array(p_trade_id, p_member_id, p_user_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
BEGIN
  IF v_trade.status <> 'pending'::public.trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.trades
     SET status = 'rejected'::public.trade_status
   WHERE id = p_trade_id
     AND status = 'pending'::public.trade_status;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  __request_result := jsonb_build_object(
    'proposerMemberId', v_trade.proposer_member_id,
    'recipientMemberId', v_trade.recipient_member_id
  ); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

-- Canonical SQL source for public.withdraw_trade_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
  __request_context jsonb;
  __request_result jsonb;
  v_trade trades%ROWTYPE;
BEGIN
  v_trade := private.begin_trade_action(p_trade_id, p_member_id, p_user_id, 'withdraw');
  __request_context := private.request_begin('public.withdraw_trade_atomic', jsonb_build_array(p_trade_id, p_member_id, p_user_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
DECLARE
  v_previous_flag text;
BEGIN
  IF v_trade.status <> 'pending'::public.trade_status AND NOT COALESCE((
    v_trade.status = 'accepted'::public.trade_status AND v_trade.veto_window_expires_at > now()
  ), false) THEN
    RAISE EXCEPTION 'Only pending trades or trades still in their review window can be cancelled.'
      USING ERRCODE = 'P0001';
  END IF;

  v_previous_flag:=private.begin_trade_lifecycle_write();
  UPDATE public.trades
     SET status = 'withdrawn'::public.trade_status
   WHERE id = p_trade_id
     AND status = v_trade.status;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This trade can no longer be cancelled.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM private.end_trade_lifecycle_write(v_previous_flag);
  __request_result := jsonb_build_object(
    'proposerMemberId', v_trade.proposer_member_id,
    'recipientMemberId', v_trade.recipient_member_id
  ); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

-- Canonical SQL source for public.retract_trade_acceptance_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.retract_trade_acceptance_atomic(
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
  __request_context jsonb;
  __request_result jsonb;
  v_trade trades%ROWTYPE;
BEGIN
  PERFORM set_config('pancake.trade_write','true',true);
  PERFORM set_config('lock_timeout','100ms',true);
  v_trade := private.begin_trade_action(p_trade_id, p_member_id, p_user_id, 'retract');
  __request_context := private.request_begin('public.retract_trade_acceptance_atomic', jsonb_build_array(p_trade_id, p_member_id, p_user_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
DECLARE
  v_rows int;
BEGIN
  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION 'Every team has accepted this trade, so acceptance can no longer be withdrawn.' USING ERRCODE = 'PT409';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM trade_participants
     WHERE trade_id = p_trade_id AND member_id = p_member_id AND accepted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'You have not accepted this trade.' USING ERRCODE = 'PT409';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM trade_participants
     WHERE trade_id = p_trade_id AND accepted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Every team has accepted this trade, so acceptance can no longer be withdrawn.' USING ERRCODE = 'PT409';
  END IF;

  UPDATE trade_participants
     SET accepted_at = NULL
   WHERE trade_id = p_trade_id
     AND member_id = p_member_id
     AND accepted_at IS NOT NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'You have not accepted this trade.' USING ERRCODE = 'PT409';
  END IF;

  __request_result := jsonb_build_object('ok', true, 'tradeId', p_trade_id); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE='PA010';
END;
$$;

-- Canonical SQL source for public.veto_trade_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.veto_trade_atomic(
  p_trade_id uuid,
  p_member_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
  __request_result jsonb;
  v_trade trades%ROWTYPE;
BEGIN
  v_trade := private.begin_trade_action(p_trade_id, p_member_id, NULL, 'veto');
  __request_context := private.request_begin('public.veto_trade_atomic', jsonb_build_array(p_trade_id, p_member_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
DECLARE
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_is_commissioner boolean;
  v_member_veto_count int;
  v_eligible_count int;
  v_threshold int;
  v_vetoed boolean;
  v_rows int;
BEGIN
  IF v_trade.status <> 'accepted'::trade_status THEN
    RAISE EXCEPTION 'This trade is not in its veto window.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.veto_window_expires_at IS NULL OR v_trade.veto_window_expires_at <= now() THEN
    RAISE EXCEPTION 'The veto window has expired.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_trade.league_id
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF COALESCE(v_league.trade_veto_mode, 'member_vote') = 'disabled' THEN
    RAISE EXCEPTION 'Trade vetoes are disabled for this league.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = p_member_id
     AND league_id = v_trade.league_id
   FOR SHARE;

  v_is_commissioner := v_member.role IN ('commissioner'::league_member_role, 'co_commissioner'::league_member_role);

  IF COALESCE(v_league.trade_veto_mode, 'member_vote') = 'commissioner' AND NOT v_is_commissioner THEN
    RAISE EXCEPTION 'Only commissioners can veto trades in this league.'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    INSERT INTO trade_vetos (
      trade_id,
      member_id,
      veto_type
    )
    VALUES (
      p_trade_id,
      p_member_id,
      CASE WHEN v_is_commissioner THEN 'commissioner'::veto_type ELSE 'member'::veto_type END
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'You have already vetoed this trade.'
      USING ERRCODE = '23505';
  END;

  SELECT count(*)
    INTO v_member_veto_count
    FROM trade_vetos
   WHERE trade_id = p_trade_id
     AND veto_type = 'member'::veto_type;

  SELECT count(*)
    INTO v_eligible_count
    FROM league_members AS member
   WHERE member.league_id = v_trade.league_id
     AND member.id <> v_trade.proposer_member_id
     AND member.id <> v_trade.recipient_member_id
     AND NOT EXISTS (
       SELECT 1
         FROM trade_participants AS participant
        WHERE participant.trade_id = p_trade_id
          AND participant.member_id = member.id
     );

  v_threshold := GREATEST(1, CEIL(
    COALESCE(v_eligible_count, 0)::numeric *
    COALESCE(v_league.trade_veto_threshold_percent, 50)::numeric / 100
  )::int);

  IF COALESCE(v_league.trade_veto_mode, 'member_vote') = 'commissioner' THEN
    v_vetoed := v_is_commissioner;
  ELSE
    v_vetoed := v_is_commissioner OR COALESCE(v_member_veto_count, 0) >= v_threshold;
  END IF;

  IF v_vetoed THEN
    UPDATE trades
       SET status = 'vetoed'::trade_status,
           vetoed_at = now()
     WHERE id = p_trade_id
       AND status = 'accepted'::trade_status;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Failed to veto trade atomically.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  __request_result := jsonb_build_object(
    'vetoed', v_vetoed,
    'vetoCount', COALESCE(v_member_veto_count, 0),
    'threshold', v_threshold,
    'proposerMemberId', v_trade.proposer_member_id,
    'recipientMemberId', v_trade.recipient_member_id,
    'participantMemberIds', COALESCE(
      (
        SELECT jsonb_agg(participant.member_id ORDER BY participant.sort_order, participant.member_id)
          FROM trade_participants AS participant
         WHERE participant.trade_id = p_trade_id
      ),
      jsonb_build_array(v_trade.proposer_member_id, v_trade.recipient_member_id)
    )
  ); EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

-- Canonical SQL source for public.set_trade_roster_plan_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.set_trade_roster_plan_atomic(
  p_trade_id uuid, p_member_id uuid, p_user_id uuid,
  p_taxi_player_ids uuid[], p_ir_player_ids uuid[], p_drop_player_ids uuid[], p_roster_moves jsonb DEFAULT '[]'::jsonb
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  __request_context jsonb;
  v_trade trades%ROWTYPE;
  v_all uuid[];
BEGIN
  PERFORM set_config('pancake.trade_write','true',true);
  PERFORM set_config('lock_timeout','100ms',true);
  IF jsonb_typeof(p_roster_moves) IS DISTINCT FROM 'array' OR jsonb_array_length(p_roster_moves)>100 THEN
    RAISE EXCEPTION 'Roster moves must be an array of at most 100 players.' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_roster_moves) move WHERE jsonb_typeof(move) IS DISTINCT FROM 'object'
    OR move->>'destination' IS NULL OR move->>'destination' NOT IN ('active','ir','taxi')
    OR move->>'playerId' IS NULL OR move->>'playerId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'Each roster move requires a player and a Regular, IR, or taxi destination.' USING ERRCODE='22023';
  END IF;
  v_all := p_taxi_player_ids || p_ir_player_ids || p_drop_player_ids || ARRAY(SELECT (move->>'playerId')::uuid FROM jsonb_array_elements(p_roster_moves) move);
  IF p_taxi_player_ids IS NULL OR p_ir_player_ids IS NULL OR p_drop_player_ids IS NULL
    OR cardinality(v_all) > 100 OR EXISTS (SELECT 1 FROM unnest(v_all) id GROUP BY id HAVING id IS NULL OR count(*) > 1) THEN
    RAISE EXCEPTION 'Placements and drops must be unique players.' USING ERRCODE = '22023';
  END IF;
  v_trade := private.begin_trade_action(p_trade_id, p_member_id, p_user_id, 'plan', '{}', v_all);
  __request_context := private.request_begin('public.set_trade_roster_plan_atomic', jsonb_build_array(p_trade_id, p_member_id, p_user_id, p_taxi_player_ids, p_ir_player_ids, p_drop_player_ids, p_roster_moves), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
DECLARE v_preview jsonb;
BEGIN
  IF v_trade.status NOT IN ('pending','accepted') OR v_trade.status='accepted' AND jsonb_array_length(v_trade.legality_issues)=0
    OR v_trade.status='pending' AND v_trade.expires_at <= now() THEN
    RAISE EXCEPTION 'Choose placements and drops while the trade is pending.';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_roster_moves) move WHERE move->>'destination'='taxi') THEN
    RAISE EXCEPTION 'Only incoming players can be placed on Taxi.' USING ERRCODE='PT422',DETAIL='TRADE_TAXI_INCOMING_ONLY';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_taxi_player_ids) choice(player_id)
    WHERE NOT private.taxi_player_eligible(v_trade.league_id,choice.player_id)) THEN
    RAISE EXCEPTION 'Taxi requires a rookie or fewer than 65 known career games.' USING ERRCODE='PT422',DETAIL='TRADE_TAXI_INELIGIBLE';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_taxi_player_ids || p_ir_player_ids) choice(player_id) WHERE NOT EXISTS
    (SELECT 1 FROM trade_items WHERE trade_id = p_trade_id AND to_member_id = p_member_id AND player_id = choice.player_id)) THEN
    RAISE EXCEPTION 'Placements must belong to incoming players.';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_drop_player_ids) choice(player_id) WHERE NOT EXISTS
    (SELECT 1 FROM roster_players WHERE league_season_id = v_trade.league_season_id AND member_id = p_member_id AND player_id = choice.player_id)
    OR EXISTS (SELECT 1 FROM trade_items WHERE trade_id = p_trade_id AND player_id = choice.player_id)) THEN
    RAISE EXCEPTION 'Drop choices must be your rostered players outside this offer.';
  END IF;
  IF EXISTS (SELECT 1 FROM roster_players WHERE league_season_id=v_trade.league_season_id AND player_id=ANY(p_ir_player_ids) AND is_on_taxi) THEN
    RAISE EXCEPTION 'Traded taxi players must remain on taxi with their original tenure.' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_roster_moves) move
    WHERE NOT EXISTS (SELECT 1 FROM roster_players roster WHERE roster.league_season_id=v_trade.league_season_id
      AND roster.member_id=p_member_id AND roster.player_id=(move->>'playerId')::uuid)
      OR EXISTS (SELECT 1 FROM trade_items WHERE trade_id=p_trade_id AND player_id=(move->>'playerId')::uuid)) THEN
    RAISE EXCEPTION 'Moves must be retained players from your own roster.' USING ERRCODE='22023';
  END IF;
  UPDATE trade_items item SET to_taxi = item.player_id = ANY(p_taxi_player_ids) OR EXISTS
    (SELECT 1 FROM roster_players WHERE league_season_id = v_trade.league_season_id AND player_id = item.player_id AND is_on_taxi),
    to_ir = item.player_id = ANY(p_ir_player_ids)
  WHERE item.trade_id = p_trade_id AND item.to_member_id = p_member_id AND item.player_id IS NOT NULL;
  UPDATE trade_participants SET drop_player_ids = p_drop_player_ids, roster_moves=p_roster_moves WHERE trade_id = p_trade_id AND member_id = p_member_id;
  IF v_trade.status='accepted' AND jsonb_array_length(v_trade.legality_issues)>0 THEN
    v_preview:=public.get_trade_roster_preview(p_trade_id,p_user_id);
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_preview) team WHERE NOT (team->>'legal')::boolean) THEN
      PERFORM public.hold_trade_for_legality_atomic(p_trade_id,NULL);
    ELSE
      UPDATE trades SET legality_issues='[]',completion_failure_reason=NULL WHERE id=p_trade_id;
    END IF;
  ELSIF EXISTS (SELECT 1 FROM trade_participants WHERE trade_id=p_trade_id AND member_id=p_member_id AND accepted_at IS NOT NULL) THEN
    PERFORM private.validate_trade_rosters(p_trade_id, p_member_id);
  END IF;
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE='PA010';
END;
$$;

-- Canonical SQL source for public.set_trade_taxi_destinations_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.set_trade_taxi_destinations_atomic(p_trade_id uuid,p_member_id uuid,p_player_ids uuid[],p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE
  __request_context jsonb;
  v_trade trades%ROWTYPE;
BEGIN
  v_trade := private.begin_trade_action(p_trade_id, p_member_id, p_user_id, 'taxi');
  __request_context := private.request_begin('public.set_trade_taxi_destinations_atomic', jsonb_build_array(p_trade_id, p_member_id, p_player_ids, p_user_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
DECLARE v_player_id uuid; v_slots int; v_count int;
BEGIN
  IF v_trade.status<>'pending' OR (v_trade.expires_at IS NOT NULL AND v_trade.expires_at<=now()) THEN
    RAISE EXCEPTION 'Choose roster destinations while the trade offer is pending.' USING ERRCODE='P0001';
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
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$$;

-- Canonical SQL source for public.submit_trade_offer_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.submit_trade_offer_atomic(
  p_user_id uuid, p_request_id uuid, p_member_id uuid, p_action text, p_payload jsonb
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  __request_context jsonb;
  __request_result uuid;
  v_member_league uuid;
  v_multi boolean := p_action LIKE '%-multi';
  v_source uuid;
BEGIN
  IF p_request_id IS NULL OR p_action IS NULL
    OR p_action NOT IN ('propose','propose-multi','edit','edit-multi','counter','counter-multi')
    OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'A request key, supported offer action, and offer payload are required.' USING ERRCODE='22023';
  END IF;
  IF p_action NOT LIKE 'propose%' THEN
    v_source := (p_payload->>'tradeId')::uuid;
    IF v_source IS NULL THEN
      RAISE EXCEPTION 'The source trade is required.' USING ERRCODE='22023';
    END IF;
  END IF;
  PERFORM private.begin_trade_action(v_source, p_member_id, p_user_id, split_part(p_action,'-',1),
    ARRAY[p_member_id, (p_payload->>'recipientMemberId')::uuid] || CASE WHEN v_multi
      THEN ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'participantMemberIds','[]'::jsonb)))::uuid[]
      ELSE '{}' END,
    CASE WHEN v_multi
      THEN ARRAY(SELECT (item->>'playerId')::uuid FROM jsonb_array_elements(COALESCE(p_payload->'items','[]'::jsonb)) AS items(item))
      ELSE ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'offerPlayerIds','[]'::jsonb)))::uuid[]
        || ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'requestPlayerIds','[]'::jsonb)))::uuid[]
    END);
  BEGIN
    __request_context := private.request_begin('public.submit_trade_offer_atomic', jsonb_build_array(p_user_id, p_request_id, p_member_id, p_action, p_payload - 'estimateId'), p_request_id, NULL, p_user_id);
  EXCEPTION WHEN invalid_parameter_value THEN
    IF EXISTS (
      SELECT 1 FROM private.request_receipts
      WHERE request_id=p_request_id AND actor IS DISTINCT FROM p_user_id
    ) OR EXISTS (
      SELECT 1 FROM private.trade_offer_requests
      WHERE user_id=p_user_id AND request_id=p_request_id AND member_id IS DISTINCT FROM p_member_id
    ) THEN
      RAISE EXCEPTION 'Not authorized to replay this trade request.' USING ERRCODE='42501';
    END IF;
    RAISE;
  END;
  SELECT league_id INTO STRICT v_member_league FROM league_members WHERE id=p_member_id;
  IF EXISTS (
    SELECT 1 FROM private.trade_offer_requests
    WHERE user_id=p_user_id AND request_id=p_request_id AND member_id IS DISTINCT FROM p_member_id
  ) THEN
    RAISE EXCEPTION 'Not authorized to replay this trade request.' USING ERRCODE='42501';
  END IF;
  IF (__request_context->>'replay')::boolean THEN RETURN (__request_context->>'result')::uuid; END IF;
  <<request_write>>
DECLARE
  v_league uuid;
  v_season uuid;
  v_recipient uuid;
  v_notes text;
  v_expiration timestamptz;
  v_offer_players uuid[];
  v_request_players uuid[];
  v_offer_picks uuid[];
  v_request_picks uuid[];
  v_offer_faab int;
  v_request_faab int;
  v_participants uuid[];
  v_items jsonb;
  v_envelope jsonb;
  v_receipt private.trade_offer_requests%ROWTYPE;
  v_inserted int;
  v_result uuid;
  v_plans jsonb; v_check_items jsonb; v_check_teams jsonb; v_check_error text; v_plan_entry record;
BEGIN
  v_notes := NULLIF(btrim(p_payload->>'notes'),'');
  v_expiration := (p_payload->>'expiresAt')::timestamptz;
  v_envelope := jsonb_build_object('version',1,'action',p_action,'memberId',p_member_id,
    'notes',v_notes,'expiresAt',v_expiration);
  IF p_payload ? 'rosterPlans' THEN v_envelope:=v_envelope||jsonb_build_object('rosterPlans',p_payload->'rosterPlans'); END IF;
  IF p_payload ? 'rosterPlan' THEN v_envelope := v_envelope||jsonb_build_object('rosterPlan',p_payload->'rosterPlan'); END IF;
  IF p_action IN ('propose','propose-multi') THEN
    v_league := (p_payload->>'leagueId')::uuid;
    v_season := (p_payload->>'leagueSeasonId')::uuid;
    IF v_league IS DISTINCT FROM v_member_league OR v_season IS NULL THEN
      RAISE EXCEPTION 'The offer must use this member''s league and a season.' USING ERRCODE='22023';
    END IF;
    v_envelope := v_envelope||jsonb_build_object('leagueId',v_league,'leagueSeasonId',v_season);
    IF NOT v_multi THEN
      v_recipient := (p_payload->>'recipientMemberId')::uuid;
      v_envelope := v_envelope||jsonb_build_object('recipientMemberId',v_recipient);
    END IF;
  ELSE
    v_envelope := v_envelope||jsonb_build_object('tradeId',v_source);
    IF NOT v_multi AND p_payload ? 'recipientMemberId' THEN
      v_recipient := (p_payload->>'recipientMemberId')::uuid;
      v_envelope := v_envelope||jsonb_build_object('recipientMemberId',v_recipient);
    END IF;
  END IF;
  IF v_multi THEN
    v_participants := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'participantMemberIds','[]'::jsonb)))::uuid[];
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'fromMemberId',(item->>'fromMemberId')::uuid,'toMemberId',(item->>'toMemberId')::uuid,
      'playerId',(item->>'playerId')::uuid,'pickId',(item->>'pickId')::uuid,
      'faabAmount',COALESCE((item->>'faabAmount')::int,0)) ORDER BY ordinal),'[]'::jsonb)
      INTO v_items FROM jsonb_array_elements(COALESCE(p_payload->'items','[]'::jsonb)) WITH ORDINALITY AS items(item,ordinal);
    v_envelope := v_envelope||jsonb_build_object('participantMemberIds',v_participants,'items',v_items);
  ELSE
    v_offer_players := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'offerPlayerIds','[]'::jsonb)))::uuid[];
    v_request_players := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'requestPlayerIds','[]'::jsonb)))::uuid[];
    v_offer_picks := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'offerPickIds','[]'::jsonb)))::uuid[];
    v_request_picks := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'requestPickIds','[]'::jsonb)))::uuid[];
    v_offer_faab := COALESCE((p_payload->>'offerFaabAmount')::int,0);
    v_request_faab := COALESCE((p_payload->>'requestFaabAmount')::int,0);
    v_envelope := v_envelope||jsonb_build_object('offerPlayerIds',v_offer_players,'requestPlayerIds',v_request_players,
      'offerPickIds',v_offer_picks,'requestPickIds',v_request_picks,
      'offerFaabAmount',v_offer_faab,'requestFaabAmount',v_request_faab);
  END IF;

  IF v_source IS NOT NULL THEN
    SELECT league_id,league_season_id,CASE WHEN p_action LIKE 'counter%' THEN proposer_member_id ELSE recipient_member_id END
      INTO v_league,v_season,v_recipient FROM trades WHERE id=v_source;
    IF NOT v_multi AND p_payload ? 'recipientMemberId'
      AND (p_payload->>'recipientMemberId')::uuid IS DISTINCT FROM v_recipient THEN
      RAISE EXCEPTION 'The replacement must keep the original counterparty.' USING ERRCODE='22023';
    END IF;
  END IF;
  v_plans:=COALESCE(p_payload->'rosterPlans','{}')||jsonb_build_object(p_member_id::text,COALESCE(p_payload->'rosterPlan','{}'));
  FOR v_plan_entry IN SELECT * FROM jsonb_each(v_plans) LOOP
    IF v_plan_entry.key<>p_member_id::text AND (jsonb_array_length(COALESCE(v_plan_entry.value->'dropPlayerIds','[]'))>0 OR jsonb_array_length(COALESCE(v_plan_entry.value->'rosterMoves','[]'))>0) THEN
      RAISE EXCEPTION 'Only a team manager can choose its drops and moves.' USING ERRCODE='42501';
    END IF;
  END LOOP;
  IF v_multi THEN v_check_items:=v_items;
  ELSE
    v_participants:=ARRAY[p_member_id,v_recipient];
    SELECT COALESCE(jsonb_agg(item),'[]') INTO v_check_items FROM (
      SELECT jsonb_build_object('playerId',id,'fromMemberId',p_member_id,'toMemberId',v_recipient) item FROM unnest(v_offer_players) id
      UNION ALL SELECT jsonb_build_object('playerId',id,'fromMemberId',v_recipient,'toMemberId',p_member_id) FROM unnest(v_request_players) id
      UNION ALL SELECT jsonb_build_object('fromMemberId',p_member_id,'toMemberId',v_recipient,'faabAmount',v_offer_faab)
      UNION ALL SELECT jsonb_build_object('fromMemberId',v_recipient,'toMemberId',p_member_id,'faabAmount',v_request_faab)
    ) items;
  END IF;
  v_check_teams:=private.check_trade_legality(v_league,v_season,v_participants,v_check_items,v_plans,v_source);
  SELECT string_agg(reason->>'message',' ') INTO v_check_error FROM jsonb_array_elements(v_check_teams) team
    CROSS JOIN LATERAL jsonb_array_elements(team->'reasons') reason
    WHERE team->>'memberId'=p_member_id::text;
  IF v_check_error IS NOT NULL THEN RAISE EXCEPTION '%',v_check_error USING ERRCODE='PT409',DETAIL=v_check_teams::text; END IF;

  INSERT INTO private.trade_offer_requests(user_id,request_id,member_id,request_payload)
    VALUES(p_user_id,p_request_id,p_member_id,v_envelope) ON CONFLICT(user_id,request_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;
  SELECT * INTO STRICT v_receipt FROM private.trade_offer_requests
    WHERE user_id=p_user_id AND request_id=p_request_id FOR UPDATE;
  IF v_receipt.member_id IS DISTINCT FROM p_member_id THEN
    RAISE EXCEPTION 'Not authorized to replay this trade request.' USING ERRCODE='42501';
  END IF;
  IF v_receipt.request_payload IS DISTINCT FROM v_envelope THEN
    RAISE EXCEPTION 'This request key already belongs to different trade terms.' USING ERRCODE='22023';
  END IF;
  IF v_receipt.completed THEN __request_result := v_receipt.result_trade_id; EXIT request_write; END IF;
  IF v_inserted=0 THEN
    RAISE EXCEPTION 'This trade request has no completed receipt.' USING ERRCODE='55000';
  END IF;

  IF p_action='propose' THEN
    v_result := public.propose_trade_atomic(v_league,v_season,p_member_id,v_recipient,
      v_offer_players,v_request_players,v_offer_picks,v_request_picks,v_notes,v_expiration,v_offer_faab,v_request_faab);
  ELSIF p_action='propose-multi' THEN
    v_result := public.propose_multi_team_trade_atomic(v_league,v_season,p_member_id,v_participants,v_items,v_notes,v_expiration);
  ELSIF v_multi THEN
    v_result := private.replace_multi_team_trade_offer(v_source,p_member_id,p_user_id,split_part(p_action,'-',1),
      v_participants,v_items,v_notes,v_expiration);
  ELSE
    v_result := private.replace_trade_offer(v_source,p_member_id,p_user_id,p_action,
      v_offer_players,v_request_players,v_offer_picks,v_request_picks,v_notes,v_expiration,v_offer_faab,v_request_faab);
  END IF;
  IF p_payload ? 'rosterPlan' AND v_result IS NOT NULL THEN
    PERFORM public.set_trade_roster_plan_atomic(v_result,p_member_id,p_user_id,
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'taxiPlayerIds'))::uuid[],
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'irPlayerIds'))::uuid[],
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'dropPlayerIds'))::uuid[],
      COALESCE(p_payload->'rosterPlan'->'rosterMoves','[]'::jsonb));
  END IF;
  IF v_result IS NOT NULL THEN
    FOR v_plan_entry IN SELECT * FROM jsonb_each(v_plans) WHERE key<>p_member_id::text LOOP
      UPDATE trade_items SET to_ir=COALESCE(v_plan_entry.value->'irPlayerIds','[]') ? player_id::text,
        to_taxi=COALESCE(v_plan_entry.value->'taxiPlayerIds','[]') ? player_id::text OR EXISTS(SELECT 1 FROM roster_players WHERE league_season_id=v_season AND roster_players.player_id=trade_items.player_id AND is_on_taxi)
        WHERE trade_id=v_result AND to_member_id=v_plan_entry.key::uuid AND player_id IS NOT NULL;
    END LOOP;
    PERFORM private.validate_trade_rosters(v_result,p_member_id);
    PERFORM private.attach_trade_estimate(v_result,p_member_id,(p_payload->>'estimateId')::uuid);
  END IF;
  UPDATE private.trade_offer_requests SET completed=true,result_trade_id=v_result
    WHERE user_id=p_user_id AND request_id=p_request_id;
  __request_result := v_result; EXIT request_write;
END request_write;
  PERFORM private.request_finish(__request_context, to_jsonb(__request_result));
  RETURN __request_result;
END;
$$;

-- Canonical SQL source for public.complete_accepted_trade_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
  v_rows int;
  v_balance int;
  v_item_faab_amount int;
  v_previous_flag text;
  v_previous_applied_trade text;
  v_drop record;
  v_move record;
BEGIN
  v_trade := private.begin_trade_action(p_trade_id, NULL, NULL, 'complete');

  IF v_trade.status <> 'accepted' THEN
    RAISE EXCEPTION 'Trade is not ready to complete';
  END IF;

  IF v_trade.veto_window_expires_at IS NULL OR v_trade.veto_window_expires_at > now() THEN
    RAISE EXCEPTION 'Trade veto window is still open';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_trade.league_id
   FOR NO KEY UPDATE NOWAIT;

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
   FOR NO KEY UPDATE NOWAIT;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trades require the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM trade_participants participant CROSS JOIN LATERAL jsonb_array_elements(participant.roster_moves) move
    WHERE participant.trade_id=p_trade_id AND move->>'destination'='taxi') THEN
    RAISE EXCEPTION 'Only incoming players can be placed on Taxi.' USING ERRCODE='PT422',DETAIL='TRADE_TAXI_INCOMING_ONLY';
  END IF;

  BEGIN
    PERFORM private.validate_trade_rosters(p_trade_id);
  EXCEPTION WHEN SQLSTATE 'PA010' OR SQLSTATE 'PT409' THEN
    PERFORM public.hold_trade_for_legality_atomic(p_trade_id,NULL);
    RETURN;
  END;

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
        USING ERRCODE = 'PA010';
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
          USING ERRCODE = 'PA010';
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
          USING ERRCODE = 'PA010';
      END IF;
    ELSE
      v_item_faab_amount := COALESCE(v_item.faab_amount, 0);
      IF v_item_faab_amount <= 0 THEN
        RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount'
          USING ERRCODE = 'PA010';
      END IF;

    END IF;
  END LOOP;

  PERFORM private.cancel_pending_trades_for_moved_assets(p_trade_id);

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
        USING ERRCODE = 'PA010';
    END IF;
  END LOOP;

  v_previous_flag := private.begin_trade_lifecycle_write();
  v_previous_applied_trade:=COALESCE(current_setting('pancake.applied_trade_id',true),'');
  PERFORM set_config('pancake.applied_trade_id',p_trade_id::text,true);
    FOR v_drop IN SELECT roster.* FROM trade_participants participant JOIN roster_players roster
      ON roster.member_id=participant.member_id AND roster.league_season_id=v_trade.league_season_id
        AND roster.player_id=ANY(participant.drop_player_ids)
      WHERE participant.trade_id=p_trade_id ORDER BY roster.player_id FOR UPDATE OF roster
    LOOP
      PERFORM private.release_roster_player_to_waivers(v_drop.id,v_trade.league_id,v_trade.league_season_id,
        v_drop.member_id,v_drop.player_id,'drop',NULL,p_trade_id);
    END LOOP;
  FOR v_move IN SELECT roster.id,roster.member_id,roster.player_id,roster.is_on_ir,roster.is_on_taxi,move->>'destination' AS destination
    FROM trade_participants participant CROSS JOIN LATERAL jsonb_array_elements(participant.roster_moves) move
    JOIN roster_players roster ON roster.player_id=(move->>'playerId')::uuid AND roster.member_id=participant.member_id
      AND roster.league_season_id=v_trade.league_season_id
    WHERE participant.trade_id=p_trade_id ORDER BY roster.player_id FOR UPDATE OF roster
  LOOP
    IF private.roster_status_game_started(v_move.player_id) THEN
      RAISE EXCEPTION 'A planned roster move waits for the player game slate to end.' USING ERRCODE='PA011';
    END IF;
    PERFORM private.authorize_taxi_acquisition(v_trade.league_id,v_trade.league_season_id,v_move.member_id,v_move.player_id,'trade',p_trade_id);
    UPDATE roster_players SET is_on_ir=v_move.destination='ir',is_on_taxi=v_move.destination='taxi',
      taxi_start_season_year=CASE WHEN v_move.destination='taxi' THEN private.taxi_start_year(v_trade.league_id,v_move.player_id,(SELECT season_year FROM league_seasons WHERE id=v_trade.league_season_id)) ELSE taxi_start_season_year END WHERE id=v_move.id;
    INSERT INTO roster_transactions(league_id,league_season_id,member_id,player_id,transaction_type,related_trade_id)
      VALUES(v_trade.league_id,v_trade.league_season_id,v_move.member_id,v_move.player_id,
        CASE WHEN v_move.destination='taxi' THEN 'taxi_designate' WHEN v_move.destination='ir' THEN 'ir_designate' WHEN v_move.is_on_taxi THEN 'taxi_return' ELSE 'ir_return' END,p_trade_id);
  END LOOP;

  WITH changed_claims AS (
    UPDATE waiver_claims AS claim
       SET status = 'cancelled',
           failure_reason = 'The selected drop player left this roster in another transaction.',
           processed_at = now(),
           drop_player_id = NULL
     WHERE claim.status = 'pending'
       AND COALESCE(claim.drop_roster_slot,'active')='active'
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
     AND COALESCE(claim.drop_roster_slot,'active')='active'
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
      PERFORM private.authorize_taxi_acquisition(v_trade.league_id,v_trade.league_season_id,v_to_member,v_item.player_id,'trade',p_trade_id);
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
          USING ERRCODE = 'PA010';
      END IF;

      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF v_item.to_taxi AND SQLERRM LIKE 'This player''s game has already started%' THEN
          RAISE EXCEPTION 'A taxi destination waits for the player''s game slate to end.' USING ERRCODE='PA011';
        END IF;
        RAISE EXCEPTION '% acquisition failed: %',
          CASE WHEN v_item.to_taxi THEN 'Taxi' WHEN v_item.to_ir THEN 'IR' ELSE 'Player' END,
          SQLERRM USING ERRCODE='PA010';
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
          USING ERRCODE = 'PA010';
      END IF;
    ELSE
      v_item_faab_amount := COALESCE(v_item.faab_amount, 0);
      IF v_item_faab_amount <= 0 THEN
        RAISE EXCEPTION 'Trade item must include a player, pick, or positive FAAB amount'
          USING ERRCODE = 'PA010';
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
         completion_failure_reason = NULL,
         legality_issues = '[]'
   WHERE id = p_trade_id
     AND status = 'accepted';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to complete trade atomically';
  END IF;

  FOR v_member_lock IN SELECT member_id FROM trade_participants WHERE trade_id=p_trade_id ORDER BY member_id LOOP
    PERFORM private.assert_accepted_trade_capacity(v_trade.league_id,v_trade.league_season_id,v_member_lock);
  END LOOP;
  PERFORM set_config('pancake.applied_trade_id',v_previous_applied_trade,true);
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

-- Canonical SQL source for public.process_due_accepted_trades_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.process_due_accepted_trades_atomic(
  p_limit int DEFAULT 50
)
RETURNS TABLE (
  trade_id uuid,
  proposer_member_id uuid,
  recipient_member_id uuid,
  participant_member_ids uuid[],
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
  v_trade_ids uuid[];
  v_asset record;
  v_error_code text;
  v_error_message text;
BEGIN
  SELECT COALESCE(array_agg(due.id), ARRAY[]::uuid[]) INTO v_trade_ids
  FROM (
    SELECT trade.id
    FROM public.trades AS trade
    JOIN public.league_seasons AS season
      ON season.id = trade.league_season_id
    JOIN public.leagues AS league
      ON league.id = trade.league_id
    WHERE trade.status = 'accepted'::public.trade_status
      AND trade.veto_window_expires_at <= now()
      AND season.is_current = true
      AND league.status IN ('active'::public.league_status, 'playoffs'::public.league_status, 'offseason'::public.league_status, 'drafting'::public.league_status)
    ORDER BY trade.veto_window_expires_at, trade.proposed_at, trade.id
    LIMIT v_limit
    FOR UPDATE OF trade SKIP LOCKED
  ) AS due;

  FOR v_asset IN
    SELECT key.league_id, key.id FROM private.trade_lock_keys(v_trade_ids) AS key
     ORDER BY key.league_id, key.kind, key.id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_asset.league_id::text), hashtext(v_asset.id::text));
  END LOOP;

  FOR v_trade IN
    SELECT
      trade.id,
      trade.proposer_member_id,
      trade.recipient_member_id,
      ARRAY(
        SELECT participant.member_id
          FROM public.trade_participants AS participant
         WHERE participant.trade_id = trade.id
         ORDER BY participant.sort_order, participant.member_id
      ) AS participant_member_ids
    FROM public.trades AS trade
    WHERE trade.id = ANY(v_trade_ids)
    ORDER BY trade.veto_window_expires_at, trade.proposed_at, trade.id
  LOOP
    BEGIN
      PERFORM public.complete_accepted_trade_atomic(v_trade.id);

      RETURN QUERY
      SELECT
        v_trade.id,
        v_trade.proposer_member_id,
        v_trade.recipient_member_id,
        CASE
          WHEN cardinality(v_trade.participant_member_ids) > 0 THEN v_trade.participant_member_ids
          ELSE ARRAY[v_trade.proposer_member_id, v_trade.recipient_member_id]
        END,
        CASE WHEN EXISTS(SELECT 1 FROM trades WHERE id=v_trade.id AND jsonb_array_length(legality_issues)>0) THEN 'deferred' ELSE 'completed' END::text,
        NULL::text,
        NULL::text;
    EXCEPTION
      WHEN SQLSTATE 'PA010' OR SQLSTATE 'PT409' THEN
        v_error_code := SQLSTATE;
        v_error_message := SQLERRM;

        PERFORM public.hold_trade_for_legality_atomic(v_trade.id, v_error_message);

        RETURN QUERY
        SELECT
          v_trade.id,
          v_trade.proposer_member_id,
          v_trade.recipient_member_id,
          CASE
            WHEN cardinality(v_trade.participant_member_ids) > 0 THEN v_trade.participant_member_ids
            ELSE ARRAY[v_trade.proposer_member_id, v_trade.recipient_member_id]
          END,
          'deferred'::text,
          v_error_code,
          v_error_message;
      WHEN SQLSTATE 'PA011' THEN
        v_error_code := SQLSTATE;
        v_error_message := SQLERRM;

        RETURN QUERY
        SELECT
          v_trade.id,
          v_trade.proposer_member_id,
          v_trade.recipient_member_id,
          CASE
            WHEN cardinality(v_trade.participant_member_ids) > 0 THEN v_trade.participant_member_ids
            ELSE ARRAY[v_trade.proposer_member_id, v_trade.recipient_member_id]
          END,
          'deferred'::text,
          v_error_code,
          v_error_message;
      WHEN serialization_failure OR deadlock_detected OR lock_not_available THEN
        v_error_code := SQLSTATE;
        v_error_message := SQLERRM;

        RETURN QUERY
        SELECT
          v_trade.id,
          v_trade.proposer_member_id,
          v_trade.recipient_member_id,
          CASE
            WHEN cardinality(v_trade.participant_member_ids) > 0 THEN v_trade.participant_member_ids
            ELSE ARRAY[v_trade.proposer_member_id, v_trade.recipient_member_id]
          END,
          'failed_retryable'::text,
          v_error_code,
          v_error_message;
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION private.trade_lock_keys(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.begin_trade_action(uuid,uuid,uuid,text,uuid[],uuid[]) FROM PUBLIC, anon, authenticated, service_role;

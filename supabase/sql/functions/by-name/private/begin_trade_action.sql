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
  v_member_id uuid;
  v_player_id uuid;
  v_participant trade_participants%ROWTYPE;
  v_wait boolean := NOT EXISTS (
    SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
  );
BEGIN
  IF p_trade_id IS NULL OR p_action IS NULL
    OR p_action NOT IN ('edit','counter','accept','reject','withdraw','retract','veto','plan','taxi','complete')
    OR (p_member_id IS NULL) <> (p_action = 'complete') THEN
    RAISE EXCEPTION 'Unsupported trade action.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found.' USING ERRCODE = 'P0002';
  END IF;

  FOR v_member_id IN
    SELECT key.id FROM private.trade_lock_keys(ARRAY[p_trade_id]) AS key WHERE key.kind = 1
    UNION SELECT unnest(p_member_ids)
    ORDER BY 1
  LOOP
    CONTINUE WHEN v_member_id IS NULL;
    IF v_wait THEN
      PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_member_id::text));
      v_wait := false;
    ELSIF NOT pg_try_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_member_id::text)) THEN
      RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE = 'PA010';
    END IF;
  END LOOP;

  FOR v_player_id IN
    SELECT key.id FROM private.trade_lock_keys(ARRAY[p_trade_id]) AS key WHERE key.kind = 2
    UNION SELECT unnest(p_player_ids)
    ORDER BY 1
  LOOP
    CONTINUE WHEN v_player_id IS NULL;
    IF v_wait THEN
      PERFORM pg_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_player_id::text));
      v_wait := false;
    ELSIF NOT pg_try_advisory_xact_lock(hashtext(v_trade.league_id::text), hashtext(v_player_id::text)) THEN
      RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE = 'PA010';
    END IF;
  END LOOP;

  BEGIN
    PERFORM 1 FROM league_members
     WHERE id = p_member_id
       AND league_id = v_trade.league_id
       AND (p_user_id IS NULL OR user_id = p_user_id)
     FOR SHARE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE = 'PA010';
  END;
  IF p_member_id IS NOT NULL AND NOT FOUND THEN
    RAISE EXCEPTION '%', CASE p_action
      WHEN 'plan' THEN 'Only the receiving manager can choose placements and drops.'
      ELSE 'Not authorized to act for this member.'
    END USING ERRCODE = '42501';
  END IF;

  BEGIN
    SELECT * INTO v_trade FROM trades WHERE id = p_trade_id FOR NO KEY UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    SELECT * INTO v_trade FROM trades WHERE id = p_trade_id;
    IF v_trade.status = 'pending' OR p_action NOT IN ('accept','reject','retract','edit','counter','taxi') THEN
      RAISE EXCEPTION 'The league is busy. Try this trade again.' USING ERRCODE = 'PA010';
    END IF;
  END;

  SELECT * INTO v_participant FROM trade_participants WHERE trade_id = p_trade_id AND member_id = p_member_id;

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
  ELSIF p_action = 'veto' AND (v_participant.member_id IS NOT NULL
    OR p_member_id IN (v_trade.proposer_member_id, v_trade.recipient_member_id)) THEN
    RAISE EXCEPTION 'Trade parties cannot veto their own trade.' USING ERRCODE = 'P0001';
  END IF;

  RETURN v_trade;
END;
$$;

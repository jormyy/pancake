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

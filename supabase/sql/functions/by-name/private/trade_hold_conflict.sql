-- Canonical SQL source for private.trade_hold_conflict.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.trade_hold_conflict(
  p_league_id uuid,
  p_season_id uuid,
  p_member_id uuid,
  p_trade_id uuid,
  p_can_withdraw boolean,
  p_remedy text,
  p_actor_member_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_names text[];
  v_holder_name text;
  v_label text;
  v_message text;
  v_offer boolean := NOT p_can_withdraw AND EXISTS (
    SELECT 1 FROM trades trade
     WHERE trade.id = p_trade_id AND trade.status = 'pending'::trade_status AND trade.proposer_member_id = p_member_id);
BEGIN
  SELECT member.team_name INTO v_holder_name FROM league_members member WHERE member.id = p_member_id;

  SELECT array_agg(member.team_name ORDER BY participant.sort_order, participant.member_id)
    INTO v_names
    FROM trade_participants participant
    JOIN league_members member ON member.id = participant.member_id
   WHERE participant.trade_id = p_trade_id
     AND participant.member_id <> p_member_id;

  IF p_actor_member_id IS NULL OR p_actor_member_id = p_member_id THEN
    IF v_names IS NULL OR cardinality(v_names) = 0 THEN
      v_label := 'Your accepted trade';
    ELSIF cardinality(v_names) = 1 THEN
      v_label := 'Your accepted trade with ' || v_names[1];
    ELSE
      v_label := 'Your accepted trade with '
        || array_to_string(v_names[1:cardinality(v_names) - 1], ', ')
        || ' and ' || v_names[cardinality(v_names)];
    END IF;
    v_message := v_label || ' needs this roster spot. '
      || CASE WHEN p_remedy = 'add' THEN 'Add a drop' ELSE 'Drop a player' END
      || CASE WHEN p_can_withdraw THEN ' or undo your acceptance.' WHEN v_offer THEN ' or withdraw your offer.' ELSE '.' END;
  ELSE
    IF v_names IS NULL OR cardinality(v_names) = 0 THEN
      v_label := v_holder_name || '''s accepted trade';
    ELSIF cardinality(v_names) = 1 THEN
      v_label := v_holder_name || '''s accepted trade with ' || v_names[1];
    ELSE
      v_label := v_holder_name || '''s accepted trade with '
        || array_to_string(v_names[1:cardinality(v_names) - 1], ', ')
        || ' and ' || v_names[cardinality(v_names)];
    END IF;
    v_message := v_label || ' needs the roster spot this trade would use. '
      || v_holder_name || ' has to make room'
      || CASE WHEN p_can_withdraw THEN ' or undo that acceptance first.' WHEN v_offer THEN ' or withdraw that offer first.' ELSE ' first.' END;
  END IF;

  RETURN jsonb_build_object(
    'tradeId', p_trade_id,
    'version', (SELECT trade.version FROM trades trade WHERE trade.id = p_trade_id),
    'holderTeamName', v_holder_name,
    'partnerTeamNames', COALESCE(to_jsonb(v_names), '[]'::jsonb),
    'canWithdraw', p_can_withdraw,
    'message', v_message
  );
END;
$$;

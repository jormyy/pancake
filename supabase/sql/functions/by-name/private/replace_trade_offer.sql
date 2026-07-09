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

  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found.'
      USING ERRCODE = 'P0002';
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

  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION '%', v_pending_error
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.expires_at IS NOT NULL AND v_trade.expires_at <= now() THEN
    UPDATE trades SET status = 'expired'::trade_status WHERE id = p_trade_id;
    RETURN NULL;
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

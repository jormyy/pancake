-- Add multi-team trade edit/counter replacement RPCs and release reservations on replaced offers.

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

  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

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

  IF v_trade.status <> 'pending'::trade_status THEN
    RAISE EXCEPTION '%', v_pending_error
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.expires_at IS NOT NULL AND v_trade.expires_at <= now() THEN
    UPDATE trades SET status = 'expired'::trade_status WHERE id = p_trade_id;
    RETURN NULL;
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

  v_parent_trade_id := COALESCE(v_trade.parent_trade_id, v_trade.id);

  v_new_trade_id := private.create_multi_team_trade_offer(
    v_trade.league_id,
    v_trade.league_season_id,
    v_new_proposer_member_id,
    p_participant_member_ids,
    p_items,
    p_notes,
    p_expires_at
  );

  UPDATE trades
     SET parent_trade_id = v_parent_trade_id,
         countered_from_trade_id = v_countered_from_trade_id,
         edited_from_trade_id = v_edited_from_trade_id,
         version = v_trade.version + 1
   WHERE id = v_new_trade_id
   RETURNING * INTO v_new_trade;

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

CREATE OR REPLACE FUNCTION public.counter_multi_team_trade_atomic(
  p_trade_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_participant_member_ids uuid[],
  p_items jsonb,
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN private.replace_multi_team_trade_offer(
    p_trade_id,
    p_member_id,
    p_user_id,
    'counter',
    p_participant_member_ids,
    p_items,
    p_notes,
    p_expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.edit_multi_team_trade_atomic(
  p_trade_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_participant_member_ids uuid[],
  p_items jsonb,
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN private.replace_multi_team_trade_offer(
    p_trade_id,
    p_member_id,
    p_user_id,
    'edit',
    p_participant_member_ids,
    p_items,
    p_notes,
    p_expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.cleanup_trade_drop_reservations_on_terminal_trade()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
BEGIN
  IF NEW.status IN (
    'rejected'::trade_status,
    'withdrawn'::trade_status,
    'countered'::trade_status,
    'edited'::trade_status,
    'expired'::trade_status,
    'vetoed'::trade_status,
    'completed'::trade_status
  ) AND OLD.status IS DISTINCT FROM NEW.status THEN
    DELETE FROM trade_drop_reservations
     WHERE trade_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.counter_multi_team_trade_atomic(uuid, uuid, uuid, uuid[], jsonb, text, timestamptz) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.counter_multi_team_trade_atomic(uuid, uuid, uuid, uuid[], jsonb, text, timestamptz) TO service_role;

REVOKE ALL ON FUNCTION public.edit_multi_team_trade_atomic(uuid, uuid, uuid, uuid[], jsonb, text, timestamptz) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.edit_multi_team_trade_atomic(uuid, uuid, uuid, uuid[], jsonb, text, timestamptz) TO service_role;


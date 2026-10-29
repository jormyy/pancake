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
BEGIN
  __request_context := private.request_begin('public.withdraw_trade_atomic', jsonb_build_array(p_trade_id, p_member_id, p_user_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
DECLARE
  v_trade trades%ROWTYPE;
  v_previous_flag text;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_trade.status <> 'pending'::public.trade_status AND NOT COALESCE((
    v_trade.status = 'accepted'::public.trade_status AND v_trade.veto_window_expires_at > now()
  ), false) THEN
    RAISE EXCEPTION 'Only pending trades or trades still in their review window can be cancelled.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.proposer_member_id <> p_member_id THEN
    RAISE EXCEPTION 'Only the trade proposer can withdraw this trade.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM public.league_members AS member
   WHERE member.id = p_member_id
     AND member.user_id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to act for this member.'
      USING ERRCODE = '42501';
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

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

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
  v_trade trades%ROWTYPE;
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

  IF v_trade.status <> 'pending'::public.trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
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

  UPDATE public.trades
     SET status = 'withdrawn'::public.trade_status
   WHERE id = p_trade_id
     AND status = 'pending'::public.trade_status;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'proposerMemberId', v_trade.proposer_member_id,
    'recipientMemberId', v_trade.recipient_member_id
  );
END;
$$;

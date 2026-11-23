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

CREATE OR REPLACE FUNCTION public.accept_trade_with_plan_atomic(
  p_trade_id uuid,p_member_id uuid,p_user_id uuid,
  p_taxi_player_ids uuid[],p_ir_player_ids uuid[],p_drop_player_ids uuid[],p_roster_moves jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  __request_context jsonb;
  __request_result jsonb;
BEGIN
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

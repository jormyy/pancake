CREATE OR REPLACE FUNCTION public.accept_trade_with_plan_atomic(
  p_trade_id uuid,p_member_id uuid,p_user_id uuid,
  p_taxi_player_ids uuid[],p_ir_player_ids uuid[],p_drop_player_ids uuid[]
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  PERFORM public.set_trade_roster_plan_atomic(p_trade_id,p_member_id,p_user_id,p_taxi_player_ids,p_ir_player_ids,p_drop_player_ids);
  RETURN public.accept_trade_atomic(p_trade_id,p_member_id);
END;
$$;

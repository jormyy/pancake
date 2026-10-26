CREATE OR REPLACE FUNCTION public.get_trade_revaluation_inputs(p_user_id uuid,p_member_id uuid,p_trade_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  terms jsonb; inputs jsonb;
  previous_user text:=current_setting('request.jwt.claim.sub',true);
  allowed boolean;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.trades t JOIN public.league_members m ON m.league_id=t.league_id
    JOIN public.leagues l ON l.id=t.league_id AND l.deleted_at IS NULL
    WHERE t.id=p_trade_id AND m.id=p_member_id AND m.user_id=p_user_id) THEN
    RAISE EXCEPTION 'This trade is not available for revaluation.' USING ERRCODE='42501';
  END IF;
  PERFORM set_config('request.jwt.claim.sub',p_user_id::text,true);
  allowed:=private.can_read_trade(p_trade_id);
  PERFORM set_config('request.jwt.claim.sub',COALESCE(previous_user,''),true);
  IF NOT allowed THEN
    RAISE EXCEPTION 'This trade is not available for revaluation.' USING ERRCODE='42501';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('fromMemberId',i.from_member_id,'toMemberId',i.to_member_id,
    'playerId',i.player_id,'pickId',i.pick_id,'faabAmount',i.faab_amount) ORDER BY i.id)
    INTO terms FROM public.trade_items i WHERE i.trade_id=p_trade_id;
  inputs:=private.build_trade_estimate_inputs(p_user_id,p_member_id,terms,false)
    ||jsonb_build_object('revaluationTradeId',p_trade_id);
  RETURN inputs||jsonb_build_object('inputVersion',md5(inputs::text),'observedAt',now());
END;
$$;

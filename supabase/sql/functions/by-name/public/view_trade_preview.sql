CREATE OR REPLACE FUNCTION public.view_trade_preview(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.view_context(p_league_id, p_member_id, p_params);
  IF NOT EXISTS (SELECT 1 FROM public.trades WHERE id = (p_params->>'tradeId')::uuid AND league_id = p_league_id
    AND private.can_read_trade(id)) THEN RAISE EXCEPTION 'This trade is not available.' USING ERRCODE = '42501'; END IF;
  RETURN public.get_trade_roster_preview((p_params->>'tradeId')::uuid, auth.uid());
END;
$$;

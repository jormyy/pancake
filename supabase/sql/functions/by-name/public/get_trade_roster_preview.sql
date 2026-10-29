CREATE OR REPLACE FUNCTION public.get_trade_roster_preview(p_trade_id uuid,p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_league uuid;
BEGIN
  SELECT league_id INTO v_league FROM trades WHERE id=p_trade_id;
  RETURN public.preview_trade_legality(p_user_id,v_league,NULL,NULL,'{}',p_trade_id);
END;
$$;
